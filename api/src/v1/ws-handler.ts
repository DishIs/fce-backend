// v1/ws-handler.ts
// ─────────────────────────────────────────────────────────────────────────────
//  WebSocket endpoint for the public developer API.
//
//  wss://api.freecustom.email/v1/ws?api_key=fce_xxx[&mailbox=addr@domain]
//  OR  Authorization: Bearer fce_xxx  (via upgrade request headers)
//
//  Auth:        API key (same as REST)
//  Gate:        Startup plan and above only
//  Limits:      Per-plan max connections (5 / 20 / 100)
//  Events:      Same "new_mail" events as the internal WS, sanitized by plan
//  Billing:     Each push event counts as 1 request toward monthly quota
// ─────────────────────────────────────────────────────────────────────────────
import WebSocket from 'ws';
import { IncomingMessage } from 'http';
import crypto from 'crypto';
import { db } from '../mongo';
import { client as redis } from '../redis';
import { API_PLANS, ApiPlanName, WS_PLANS, OTP_PLANS, apiPlanToInternalPlan } from './api-plans';

// ── In-memory connection registry ────────────────────────────────────────────

interface ApiWsClient {
  ws:       WebSocket;
  userId:   string;
  plan:     ApiPlanName;
  inboxes:  Set<string>;      // subscribed inbox addresses
  keyId:    string;           // api_key._id for quota tracking
}

// userId → set of live connections for that user
const activeConnections = new Map<string, Set<ApiWsClient>>();

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Upgrade an HTTP request to an authenticated API WebSocket.
 * Called by the WS server's `connection` event when the path starts with /v1/ws.
 */
export async function handleApiWebSocket(
  ws: WebSocket,
  req: IncomingMessage,
): Promise<void> {

  // ── 1. Extract API key ──────────────────────────────────────────────────
  const urlParams = new URLSearchParams(req.url?.split('?')[1] ?? '');
  const rawKey =
    urlParams.get('api_key') ??
    req.headers.authorization?.replace(/^Bearer\s+/i, '').trim();

  if (!rawKey) {
    ws.close(1008, 'API key required (?api_key= or Authorization: Bearer)');
    return;
  }

  // ── 2. Resolve key → user ───────────────────────────────────────────────
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

  let userId: string;
  let plan: ApiPlanName;
  let apiKeyId: string;
  let apiInboxes: string[];

  try {
    // Try cache first
    const cacheKey = `api_key_cache:${keyHash}`;
    const cached   = await redis.get(cacheKey);

    if (cached) {
      const cachedUser = JSON.parse(cached);
      userId  = cachedUser.userId;
      plan    = cachedUser.plan;
      apiKeyId = cachedUser.apiKeyId;
    } else {
      const keyDoc = await db.collection('api_keys').findOne({ keyHash, active: true });
      if (!keyDoc) { ws.close(1008, 'Invalid API key'); return; }

      const user = await db.collection('users').findOne({ wyiUserId: keyDoc.wyiUserId });
      if (!user)  { ws.close(1008, 'User not found'); return; }

      userId   = user.wyiUserId;
      plan     = (user.apiPlan as ApiPlanName) ?? 'free';
      apiKeyId = keyDoc._id.toString();

      await redis.set(cacheKey, JSON.stringify({ userId, plan, apiKeyId }), { EX: 60 });
    }

    // Fetch apiInboxes separately (not cached — needs to be live)
    const userDoc   = await db.collection('users').findOne({ wyiUserId: userId });
    apiInboxes = userDoc?.apiInboxes ?? [];

  } catch (err) {
    console.error('[api-ws] Auth error:', err);
    ws.close(1011, 'Server error during authentication');
    return;
  }

  // ── 3. Plan gate ────────────────────────────────────────────────────────
  if (!WS_PLANS.includes(plan)) {
    const hint = `WebSocket access requires Startup plan ($19/mo) or above. Your plan: ${plan}.`;
    ws.close(1008, hint);
    // Send a final message before closing so clients can display it
    try { ws.send(JSON.stringify({ type: 'error', code: 'plan_required', message: hint, upgrade_url: 'https://freecustom.email/api/pricing' })); } catch (_) {}
    return;
  }

  // ── 4. Max connections gate ─────────────────────────────────────────────
  const planConfig = API_PLANS[plan];
  const userConns  = activeConnections.get(userId) ?? new Set<ApiWsClient>();
  if (userConns.size >= planConfig.features.maxWsConnections) {
    const hint = `Max WebSocket connections (${planConfig.features.maxWsConnections}) reached for ${plan} plan.`;
    try { ws.send(JSON.stringify({ type: 'error', code: 'connection_limit', message: hint })); } catch (_) {}
    ws.close(1008, hint);
    return;
  }

  // ── 5. Resolve subscribed inboxes ───────────────────────────────────────
  const mailboxParam = urlParams.get('mailbox')?.toLowerCase();
  let subscribedInboxes: Set<string>;

  if (mailboxParam) {
    if (!apiInboxes.includes(mailboxParam)) {
      ws.close(1008, `Inbox "${mailboxParam}" not registered. POST /v1/inboxes first.`);
      return;
    }
    subscribedInboxes = new Set([mailboxParam]);
  } else {
    subscribedInboxes = new Set(apiInboxes);
  }

  if (subscribedInboxes.size === 0) {
    ws.close(1008, 'No registered inboxes. POST /v1/inboxes to register one first.');
    return;
  }

  // ── 6. Register client ──────────────────────────────────────────────────
  const client: ApiWsClient = { ws, userId, plan, inboxes: subscribedInboxes, keyId: apiKeyId };

  if (!activeConnections.has(userId)) activeConnections.set(userId, new Set());
  activeConnections.get(userId)!.add(client);

  // ── 7. Welcome frame ────────────────────────────────────────────────────
  ws.send(JSON.stringify({
    type: 'connected',
    plan,
    subscribed_inboxes:  [...subscribedInboxes],
    connection_count:    activeConnections.get(userId)!.size,
    max_connections:     planConfig.features.maxWsConnections,
    features: {
      otp_extraction: OTP_PLANS.includes(plan),
      attachments:    planConfig.features.attachments,
    },
  }));

  // ── 8. Cleanup on disconnect ────────────────────────────────────────────
  const cleanup = () => {
    const conns = activeConnections.get(userId);
    if (conns) {
      conns.delete(client);
      if (conns.size === 0) activeConnections.delete(userId);
    }
  };

  ws.on('close', cleanup);
  ws.on('error', cleanup);

  // ── 9. Heartbeat / ping-pong ────────────────────────────────────────────
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
      }
    } catch (_) { /* ignore malformed frames */ }
  });
}

/**
 * Called by the internal Redis pub/sub handler whenever a new email arrives.
 * Broadcasts sanitized events to all API WS clients subscribed to that inbox.
 * Each broadcast counts as 1 request against the monthly quota (async, no-block).
 */
export function notifyApiWsClients(mailbox: string, event: any): void {
  for (const [, connections] of activeConnections) {
    for (const client of connections) {
      if (!client.inboxes.has(mailbox)) continue;
      if (client.ws.readyState !== WebSocket.OPEN) continue;

      const cfg = API_PLANS[client.plan];

      // Sanitize OTP based on plan
      const sanitized = { ...event };
      if (!OTP_PLANS.includes(client.plan)) {
        sanitized.otp = event.otp ? '__DETECTED__' : null;
        sanitized.verificationLink = event.verificationLink ? '__DETECTED__' : null;
        sanitized._upgrade_hint = event.otp || event.verificationLink
          ? 'Upgrade to Developer plan to see OTP values in real-time.'
          : undefined;
      }

      client.ws.send(JSON.stringify(sanitized));

      // Count this push as 1 request toward the monthly quota (fire-and-forget)
      incrementMonthlyUsage(client.keyId).catch(() => {});
    }
  }
}

/**
 * Returns a snapshot of current API WebSocket connection counts.
 * Useful for monitoring/stats endpoints.
 */
export function getApiWsStats(): { total: number; byUser: Record<string, number> } {
  let total = 0;
  const byUser: Record<string, number> = {};
  for (const [uid, conns] of activeConnections) {
    byUser[uid] = conns.size;
    total += conns.size;
  }
  return { total, byUser };
}

// ── Internal ──────────────────────────────────────────────────────────────────

async function incrementMonthlyUsage(apiKeyId: string): Promise<void> {
  const monthKey = `rl:m:${apiKeyId}:${new Date().toISOString().slice(0, 7)}`;
  await redis.incr(monthKey);
}