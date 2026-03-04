// server.ts  (updated — v1 public API added)
import express from 'express';
import { createServer } from 'http';
import WebSocket from 'ws';
import { listHandler, messageHandler, deleteHandler } from './mailbox';
import { getStats, statsHandler } from './statistics';
import { subscriber } from './redis';
import dotenv from 'dotenv';
import { connectToMongo } from './mongo';
import {
  addDomainHandler,
  getDomainsHandler,
  getUserProfileHandler,
  muteSenderHandler,
  upsertUserHandler,
  unmuteSenderHandler,
  getUserStorageHandler,
  getUserStatusHandler,
  updateSettingsHandler,
  getSettingsHandler,
  upgradeUserSubscriptionHandler,
  saveFcmTokenHandler,
} from './user';
import { deleteDomainHandler, getDashboardDataHandler, verifyDomainHandler } from './domain-handler';
import { addInboxHandler } from './inbox-handler';
import { domainsHandler } from './domains';
import { handlePaddleSubscriptionEvent } from './paddle-handler';

// ── v1 public API ─────────────────────────────────────────────────────────────
import { createPublicV1Router } from './v1/router';
import { handleApiWebSocket, notifyApiWsClients } from './v1/ws-handler';
import {
  generateApiKeyHandler,
  listApiKeysHandler,
  revokeApiKeyHandler,
  setApiPlanHandler,
  addApiCreditsHandler,
} from './v1/api-key-handler';

import jwt from 'jsonwebtoken';
import { getApiStatusHandler } from './api-status-handler';
import { getPaymentLogsHandler } from './payment-logs-handler';
import { requestDeleteAccountHandler, restoreAccountHandler, getDeletionListHandler } from './deletion-handler';

dotenv.config();

connectToMongo().then(() => {
  const app = express();
  const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;

  if (!INTERNAL_API_KEY) {
    throw new Error('FATAL: INTERNAL_API_KEY is not set. The service cannot run securely.');
  }

  const internalApiAuth = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    const providedKey = req.header('x-internal-api-key');
    if (providedKey && providedKey === INTERNAL_API_KEY) return next();
    return res.status(401).json({ success: false, message: 'Unauthorized: Invalid or missing API key.' });
  };

  app.use(express.json());

  // ── Internal API auth — skip for WebSocket upgrades AND /v1 routes ────────
  app.use((req, res, next) => {
    const isWsUpgrade = req.headers.upgrade?.toLowerCase() === 'websocket';
    const isV1 = req.path.startsWith('/v1');
    if (isWsUpgrade || isV1) return next();
    return internalApiAuth(req, res, next);
  });

  const server = createServer(app);
  const wss = new WebSocket.Server({ server });
  const PORT = process.env.PORT || 3000;

  // ─────────────────────────────────────────────────────────────────────────
  // Internal API Routes (protected by INTERNAL_API_KEY)
  // ─────────────────────────────────────────────────────────────────────────

  // Mailbox
  app.get('/mailbox/:name', listHandler);
  app.get('/mailbox/:name/message/:id', messageHandler);
  app.delete('/mailbox/:name/message/:id', deleteHandler);

  // Auth & User Lifecycle
  app.post('/auth/upsert-user', upsertUserHandler);
  app.post('/user/status', getUserStatusHandler);
  app.get('/user/profile/:wyiUserId', getUserProfileHandler);

  // Account deletion (7-day cooldown, then permanent by worker)
  app.post('/user/delete-account', requestDeleteAccountHandler);
  app.post('/user/restore-account', restoreAccountHandler);
  app.get('/user/deletion-list', getDeletionListHandler);

  // Settings & Dashboard
  app.post('/user/settings', updateSettingsHandler);
  app.post('/user/get-settings', getSettingsHandler);
  app.get('/user/:wyiUserId/dashboard-data', getDashboardDataHandler);
  app.get('/user/:wyiUserId/storage', getUserStorageHandler);

  // Domains
  app.get('/user/:wyiUserId/domains', getDomainsHandler);
  app.post('/user/domains', addDomainHandler);
  app.post('/user/domains/verify', verifyDomainHandler);
  app.delete('/user/domains', deleteDomainHandler);

  // Features (Mute, Inboxes)
  app.post('/user/mute', muteSenderHandler);
  app.delete('/user/mute', unmuteSenderHandler);
  app.post('/user/inboxes', addInboxHandler);

  // FCM / Notifications
  app.post('/user/fcm-token', saveFcmTokenHandler);

  // Billing
  app.post('/user/upgrade', upgradeUserSubscriptionHandler);
  app.post('/paddle/subscription-event', handlePaddleSubscriptionEvent);
  // Billing history (payment logs)
  // ?limit=50  ?offset=0  ?type=app|api|credits
  app.get('/user/payment-logs/:wyiUserId', getPaymentLogsHandler);


  // ── API key management (internal — called by the Next.js dashboard) ─────
  app.post('/user/api-keys', generateApiKeyHandler);
  app.get('/user/api-keys/:wyiUserId', listApiKeysHandler);
  app.delete('/user/api-keys', revokeApiKeyHandler);
  app.post('/user/api-plan', setApiPlanHandler);
  app.post('/user/api-credits', addApiCreditsHandler);

  app.get('/domains', domainsHandler);
  app.get('/health', statsHandler);

  // API status (plan, credits, usage, feature flags, upsell nudges)
  app.get('/user/api-status/:wyiUserId', getApiStatusHandler);


  // ─────────────────────────────────────────────────────────────────────────
  // Public Developer API — /v1  (no internal key, API-key auth per request)
  // Mounted on api.freecustom.email/v1 via Nginx proxy_pass
  // ─────────────────────────────────────────────────────────────────────────
  app.use('/v1', createPublicV1Router());

  // ─────────────────────────────────────────────────────────────────────────
  // WebSocket logic
  // ─────────────────────────────────────────────────────────────────────────
  const mailboxClients: Record<string, Set<WebSocket>> = {};

  async function sendStatsToAllStatsClients() {
    const statsClients = mailboxClients['stats'];
    if (!statsClients || statsClients.size === 0) return;
    try {
      const [queued, denied] = await Promise.all([getStats('queued'), getStats('denied')]);
      const payload = JSON.stringify({ type: 'stats', queued, denied });
      for (const ws of statsClients) {
        if (ws.readyState === WebSocket.OPEN) ws.send(payload);
      }
    } catch (err) {
      console.error('Error sending stats via WS:', err);
    }
  }

  wss.on('connection', (ws: WebSocket, req) => {
    const urlParams = new URLSearchParams(req.url?.split('?')[1] ?? '');

    // ── Route API WebSocket connections (/v1/ws) ──────────────────────────
    if (req.url?.startsWith('/v1/ws')) {
      handleApiWebSocket(ws, req);
      return;
    }

    // ── Internal dashboard WebSocket (existing logic) ─────────────────────
    const mailbox = urlParams.get('mailbox');
    const wsToken = urlParams.get('token');

    if (!mailbox) { ws.close(1008, 'Missing mailbox'); return; }

    try {
      const decoded = jwt.verify(
        wsToken ?? '',
        process.env.JWT_SECRET!,
      ) as jwt.JwtPayload;

      if (decoded.mailbox !== mailbox) {
        ws.close(1008, 'Token mailbox mismatch');
        return;
      }
    } catch {
      ws.close(1008, 'Unauthorized');
      return;
    }

    if (!mailboxClients[mailbox]) mailboxClients[mailbox] = new Set();
    mailboxClients[mailbox].add(ws);

    if (mailbox === 'stats') sendStatsToAllStatsClients();

    ws.on('close', () => {
      mailboxClients[mailbox]?.delete(ws);
      if (mailboxClients[mailbox]?.size === 0) delete mailboxClients[mailbox];
    });
  });

  function notifyMailbox(mailbox: string, event: any) {
    const clients = mailboxClients[mailbox];
    if (clients) {
      const message = JSON.stringify(event);
      clients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) ws.send(message);
      });
    }
  }

  (async () => {
    await subscriber.pSubscribe('mailbox:events:*', (message, channel) => {
      try {
        const event = JSON.parse(message);
        const mailbox = channel.split(':')[2];

        if (mailbox === 'stats') {
          sendStatsToAllStatsClients();
          return;
        }

        // Internal dashboard clients
        notifyMailbox(mailbox, event);

        // ── Also push to API WebSocket clients subscribed to this inbox ──
        notifyApiWsClients(mailbox, event);
      } catch (e) {
        console.error('Failed to handle pub/sub message:', e);
      }
    });

    await subscriber.pSubscribe('__keyevent@*__:set', async (message) => {
      if (message === 'stats:queued' || message === 'stats:denied') {
        await sendStatsToAllStatsClients();
      }
    });
  })();

  server.listen(PORT, () => {
    console.log(`Server + WS running on http://localhost:${PORT}`);
    console.log(`Public API available at /v1`);
  });
});