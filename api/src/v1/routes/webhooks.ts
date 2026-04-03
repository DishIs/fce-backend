// api/src/v1/routes/webhooks.ts
// ─────────────────────────────────────────────────────────────────────────────
//  Webhook subscription management for Make.com, Zapier, and any REST-hooks
//  compatible platform.
//
//  POST   /v1/webhooks          — register a webhook (attach)
//  DELETE /v1/webhooks/:id      — unregister a webhook (detach)
//  GET    /v1/webhooks          — list active webhooks for this user
//
//  Plan gate: same as WebSocket — Startup and above (WS_PLANS).
//  Rationale: webhooks are the HTTP equivalent of WebSocket push. Gating them
//  at the same tier keeps the feature set consistent and prevents free/developer
//  users from using Make/Zapier as a free polling workaround.
// ─────────────────────────────────────────────────────────────────────────────
import { Router, Request, Response } from 'express';
import { db } from '../../config/mongo';
import { ObjectId } from 'mongodb';
import { WEBHOOK_PLANS } from '../api-plans';
import crypto from 'crypto';

const router = Router();

// ── Plan gate helper ──────────────────────────────────────────────────────────
function assertWebhookPlan(req: Request, res: Response): boolean {
  if (!WEBHOOK_PLANS.includes(req.apiUser!.plan)) {
    res.status(403).json({
      success:          false,
      error:            'plan_required',
      message:          `Webhook subscriptions require Growth plan ($49/mo) or above. Your plan: ${req.apiUser!.plan}.`,
      upgrade_required: true,
      recommended_plan: 'growth',
      pricing_url:      'https://freecustom.email/api/pricing',
      upgrade_url:      'https://freecustom.email/api/pricing',
    });
    return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/webhooks — register (Make/Zapier calls this on attach/subscribe)
// Body: { url: string, inbox: string }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', async (req: Request, res: Response): Promise<any> => {
  if (!assertWebhookPlan(req, res)) return;

  const { url, inbox } = req.body;
  const apiUser = req.apiUser!;

  if (!url || !inbox) {
    return res.status(400).json({
      success: false,
      error:   'missing_fields',
      message: '`url` and `inbox` are required.',
    });
  }

  // Verify ownership of the inbox
  const user = await db.collection('users').findOne({
    wyiUserId:  apiUser.userId,
    apiInboxes: inbox.toLowerCase(),
  });

  if (!user) {
    return res.status(403).json({
      success: false,
      error:   'inbox_not_owned',
      message: `Inbox "${inbox}" is not registered. POST /v1/inboxes first.`,
    });
  }

  try {
    const secret = crypto.randomBytes(32).toString('hex');

    const doc = {
      wyiUserId:    apiUser.userId,
      inbox:        inbox.toLowerCase(),
      url,
      secret,
      createdAt:    new Date(),
      active:       true,
      failureCount: 0,
    };

    const result = await db.collection('webhooks').insertOne(doc);

    return res.status(201).json({
      success: true,
      id:      result.insertedId.toString(),
      inbox:   doc.inbox,
      url:     doc.url,
      secret:  secret,
    });
  } catch {
    return res.status(500).json({ success: false, error: 'server_error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /v1/webhooks/:id — unregister (Make/Zapier calls this on detach/unsubscribe)
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/:id', async (req: Request, res: Response): Promise<any> => {
  if (!assertWebhookPlan(req, res)) return;

  const { id } = req.params;
  const apiUser = req.apiUser!;

  try {
    const result = await db.collection('webhooks').deleteOne({
      _id:       new ObjectId(id),
      wyiUserId: apiUser.userId,
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({
        success: false,
        error:   'not_found',
        message: 'Webhook not found or does not belong to this account.',
      });
    }

    return res.json({ success: true, message: 'Webhook unregistered.' });
  } catch {
    return res.status(500).json({ success: false, error: 'server_error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /v1/webhooks — list active webhooks for this user
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', async (req: Request, res: Response): Promise<any> => {
  if (!assertWebhookPlan(req, res)) return;

  const apiUser = req.apiUser!;
  try {
    const hooks = await db
      .collection('webhooks')
      .find(
        { wyiUserId: apiUser.userId, active: true },
        { projection: { _id: 1, inbox: 1, url: 1, createdAt: 1, failureCount: 1, secret: 0 } },
      )
      .toArray();

    return res.json({ success: true, data: hooks, count: hooks.length });
  } catch {
    return res.status(500).json({ success: false, error: 'server_error' });
  }
});

export default router;

// ─────────────────────────────────────────────────────────────────────────────
//  notifyWebhooks — called from server.ts pub/sub handler on every new email.
//  Fire-and-forget: never blocks the main event loop.
//  Auto-disables hooks that fail 10+ times consecutively.
// ─────────────────────────────────────────────────────────────────────────────
export async function notifyWebhooks(mailbox: string, event: any): Promise<void> {
  let hooks: any[];

  try {
    hooks = await db
      .collection('webhooks')
      .find({ inbox: mailbox, active: true })
      .toArray();
  } catch (err) {
    console.error('[webhooks] DB error fetching hooks:', err);
    return;
  }

  if (!hooks.length) return;

  const payload = JSON.stringify(event);

  for (const hook of hooks) {
    // Fire and forget logging logic
    const startTime = Date.now();
    fetch(hook.url, {
      method:  'POST',
      headers: { 
        'Content-Type': 'application/json',
        'X-Webhook-Secret': hook.secret || '',
      },
      body:    payload,
      signal:  AbortSignal.timeout(10_000),
    })
      .then(async (res) => {
        const success = res.ok;
        await logWebhookEvent(hook, 'email.received', success ? 'success' : 'failed', res.status);
        
        if (success) {
          // Reset failure counter on successful delivery
          if (hook.failureCount > 0) {
            await db.collection('webhooks').updateOne(
              { _id: hook._id },
              { $set: { failureCount: 0 } },
            );
          }
        } else {
          await incrementFailure(hook);
        }
      })
      .catch(async (err) => {
        console.error(`[webhooks] Delivery failed for hook ${hook._id}:`, err.message);
        await logWebhookEvent(hook, 'email.received', 'failed', 0);
        await incrementFailure(hook);
      });
  }
}

async function logWebhookEvent(hook: any, eventType: string, status: 'success' | 'failed' | 'retrying', statusCode: number) {
  try {
    await db.collection('webhook_logs').insertOne({
      webhookId: hook._id,
      wyiUserId: hook.wyiUserId,
      eventType,
      targetUrl: hook.url,
      status,
      responseCode: statusCode,
      timestamp: new Date(),
      retryCount: hook.failureCount || 0
    });
  } catch (err) {
    // Ignore log errors to not block flow
  }
}

async function incrementFailure(hook: any): Promise<void> {
  const updated = await db.collection('webhooks').findOneAndUpdate(
    { _id: hook._id },
    { $inc: { failureCount: 1 } },
    { returnDocument: 'after' },
  );

  // Auto-disable after 10 consecutive failures so dead URLs don't pile up
  if (updated && updated.failureCount >= 10) {
    await db.collection('webhooks').updateOne(
      { _id: hook._id },
      { $set: { active: false, disabledAt: new Date(), disabledReason: 'too_many_failures' } },
    );
    console.warn(`[webhooks] Hook ${hook._id} auto-disabled after 10 failures (url: ${hook.url})`);
  }
}