// server.ts  (updated — /domains/expiry added)
// ─────────────────────────────────────────────────────────────────────────────
//  Changes from previous version:
//    • domainsHandler now imported alongside domainExpiryHandler
//    • GET /domains/expiry added (authenticated, returns full expiry table)
// ─────────────────────────────────────────────────────────────────────────────
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
import { domainsHandler, domainExpiryHandler } from './domains';   // ← updated import
import { handlePaddleSubscriptionEvent } from './paddle-handler';

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
import { changeApiPlanHandler } from './api-plan-change-handler';
import {
  listApiCustomDomains,
  addApiCustomDomain,
  verifyApiCustomDomain,
  deleteApiCustomDomain,
} from './api-custom-domains-handler';
import cors from 'cors';
import { notifyWebhooks } from './v1/routes/webhooks';



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

  // Allow all origins for the public /v1 API, block everything else
  app.use('/v1', cors({
    origin: '*',                          // public API — any origin is fine
    methods: ['GET', 'POST', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    exposedHeaders: [
      'X-API-Plan',
      'X-RateLimit-Limit-Second',
      'X-RateLimit-Remaining-Second',
      'X-RateLimit-Limit-Month',
      'X-RateLimit-Remaining-Month',
      'Retry-After',
    ],
  }));

  app.use((req, res, next) => {
    const isWsUpgrade = req.headers.upgrade?.toLowerCase() === 'websocket';
    const isV1 = req.path.startsWith('/v1');
    // /domains and /domains/expiry skip internal-key auth — they use JWT instead
    const isDomains = req.path === '/domains' || req.path.startsWith('/domains/');
    if (isWsUpgrade || isV1 || isDomains) return next();
    return internalApiAuth(req, res, next);
  });

  const server = createServer(app);
  const wss = new WebSocket.Server({ server });
  const PORT = process.env.PORT || 3000;

  // ── Mailbox ────────────────────────────────────────────────────────────────
  app.get('/mailbox/:name', listHandler);
  app.get('/mailbox/:name/message/:id', messageHandler);
  app.delete('/mailbox/:name/message/:id', deleteHandler);

  // ── Auth & User Lifecycle ──────────────────────────────────────────────────
  app.post('/auth/upsert-user', upsertUserHandler);
  app.post('/user/status', getUserStatusHandler);
  app.get('/user/profile/:wyiUserId', getUserProfileHandler);
  app.post('/user/delete-account', requestDeleteAccountHandler);
  app.post('/user/restore-account', restoreAccountHandler);
  app.get('/user/deletion-list', getDeletionListHandler);

  // ── Settings & Dashboard ───────────────────────────────────────────────────
  app.post('/user/settings', updateSettingsHandler);
  app.post('/user/get-settings', getSettingsHandler);
  app.get('/user/:wyiUserId/dashboard-data', getDashboardDataHandler);
  app.get('/user/:wyiUserId/storage', getUserStorageHandler);

  // ── Domains ────────────────────────────────────────────────────────────────
  app.get('/user/:wyiUserId/domains', getDomainsHandler);
  app.post('/user/domains', addDomainHandler);
  app.post('/user/domains/verify', verifyDomainHandler);
  app.delete('/user/domains', deleteDomainHandler);

  // ── Features ───────────────────────────────────────────────────────────────
  app.post('/user/mute', muteSenderHandler);
  app.delete('/user/mute', unmuteSenderHandler);
  app.post('/user/inboxes', addInboxHandler);
  app.post('/user/fcm-token', saveFcmTokenHandler);
  app.get('/user/api-custom-domains', listApiCustomDomains);
  app.post('/user/api-custom-domains', addApiCustomDomain);
  app.post('/user/api-custom-domains/:domain/verify', verifyApiCustomDomain);
  app.delete('/user/api-custom-domains/:domain', deleteApiCustomDomain);


  // ── Billing ────────────────────────────────────────────────────────────────
  app.post('/user/upgrade', upgradeUserSubscriptionHandler);
  app.post('/paddle/subscription-event', handlePaddleSubscriptionEvent);
  app.get('/user/payment-logs/:wyiUserId', getPaymentLogsHandler);
  app.post('/user/api-plan/change', changeApiPlanHandler);

  // ── API key management ─────────────────────────────────────────────────────
  app.post('/user/api-keys', generateApiKeyHandler);
  app.get('/user/api-keys/:wyiUserId', listApiKeysHandler);
  app.delete('/user/api-keys', revokeApiKeyHandler);
  app.post('/user/api-plan', setApiPlanHandler);
  app.post('/user/api-credits', addApiCreditsHandler);

  // ── Public domain lists (JWT-gated, no internal key required) ─────────────
  app.get('/domains', domainsHandler);
  app.get('/domains/expiry', domainExpiryHandler);   // ← NEW

  app.get('/health', statsHandler);
  app.get('/user/api-status/:wyiUserId', getApiStatusHandler);

  // ── Public Developer API ───────────────────────────────────────────────────
  app.use('/v1', createPublicV1Router());

  // ── WebSocket ──────────────────────────────────────────────────────────────
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

    if (req.url?.startsWith('/v1/ws')) {
      handleApiWebSocket(ws, req);
      return;
    }

    const mailbox = urlParams.get('mailbox');
    const wsToken = urlParams.get('token');

    if (!mailbox) { ws.close(1008, 'Missing mailbox'); return; }

    try {
      const decoded = jwt.verify(wsToken ?? '', process.env.JWT_SECRET!) as jwt.JwtPayload;
      if (decoded.mailbox !== mailbox) { ws.close(1008, 'Token mailbox mismatch'); return; }
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
    if (!clients) return;
    const message = JSON.stringify(event);
    clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(message); });
  }

  (async () => {
    await subscriber.pSubscribe('mailbox:events:*', (message, channel) => {
      try {
        const event = JSON.parse(message);
        const mailbox = channel.split(':')[2];
        if (mailbox === 'stats') { sendStatsToAllStatsClients(); return; }
        notifyMailbox(mailbox, event);
        notifyApiWsClients(mailbox, event);
        notifyWebhooks(mailbox, event).catch(err =>
          console.error('[pubsub] notifyWebhooks error:', err)
        );
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