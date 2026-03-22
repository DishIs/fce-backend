import express from 'express';
import { createServer } from 'http';
import WebSocket from 'ws';
import { listHandler, messageHandler, deleteHandler } from './services/mailbox';
import { getStats, statsHandler } from './services/statistics';
import { subscriber } from './config/redis';
import dotenv from 'dotenv';
import { connectToMongo } from './config/mongo';
import { client as redis } from './config/redis';
import crypto from 'crypto';
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
} from './services/user';
import { deleteDomainHandler, getDashboardDataHandler, verifyDomainHandler } from './handlers/domain-handler';
import { addInboxHandler } from './handlers/inbox-handler';
import { domainsHandler, domainExpiryHandler } from './services/domains';
import { handlePaddleSubscriptionEvent } from './handlers/paddle-handler';

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
import { getApiStatusHandler } from './handlers/api-status-handler';
import { getPaymentLogsHandler } from './handlers/payment-logs-handler';
import { requestDeleteAccountHandler, restoreAccountHandler, getDeletionListHandler } from './handlers/deletion-handler';
import { changeApiPlanHandler } from './handlers/api-plan-change-handler';
import {
  listApiCustomDomains,
  addApiCustomDomain,
  verifyApiCustomDomain,
  deleteApiCustomDomain,
} from './handlers/api-custom-domains-handler';
import cors from 'cors';
import { notifyWebhooks } from './v1/routes/webhooks';
import { deleteInboxNoteHandler, getInboxNotesHandler, upsertInboxNoteHandler } from './handlers/inbox-notes-handler';
import { deleteInboxHandler } from './handlers/delete-inbox-handler';
import { attachIdentityContext, progressiveFrictionEngine } from './middlewares/abuse-engine';
import { verifySignature } from './utils/crypto';

declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
    }
  }
}

dotenv.config();

connectToMongo().then(() => {
  const app = express();
  app.set('trust proxy', true);
  const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;

  if (!INTERNAL_API_KEY) {
    throw new Error('FATAL: INTERNAL_API_KEY is not set. The service cannot run securely.');
  }

  const internalApiAuth = [
    async (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      const providedKey = req.header('x-internal-api-key');
      if (providedKey && providedKey === INTERNAL_API_KEY) {
        const signature = req.header('x-signature') as string;
        const timestamp = req.header('x-timestamp') as string;
        const nonce = req.header('x-nonce') as string;
        const idempotencyKey = req.header('x-idempotency-key') as string;
        const secret = process.env.INTERNAL_API_SECRET || '';

        const pathAndQuery = req.originalUrl || req.url;
        const method = req.method;

        if (!await verifySignature(signature, timestamp, method, pathAndQuery, req.rawBody, secret, nonce)) {
            return res.status(403).json({ success: false, message: 'Forbidden: Invalid signature.' });
        }
        
        // Handle Idempotency (safe retries)
        if (idempotencyKey) {
            const idempKey = `idempotency:${idempotencyKey}`;
            const cachedResponseStr = await redis.get(idempKey);
            
            if (cachedResponseStr) {
                try {
                    const cachedResponse = JSON.parse(cachedResponseStr);
                    const payloadHash = crypto.createHash('sha256').update(req.rawBody ? req.rawBody.toString('utf8') : '').digest('hex');
                    if (cachedResponse.payloadHash === payloadHash) {
                        return res.status(cachedResponse.status).json(cachedResponse.body);
                    } else {
                        return res.status(400).json({ success: false, message: 'Idempotency key reused with different payload.' });
                    }
                } catch (e) {
                    console.error("Failed to parse cached idempotency response", e);
                }
            }
            
            const originalJson = res.json;
            res.json = function (body) {
                const payloadHash = crypto.createHash('sha256').update(req.rawBody ? req.rawBody.toString('utf8') : '').digest('hex');
                const cacheData = JSON.stringify({
                    status: res.statusCode,
                    body,
                    payloadHash
                });
                redis.set(idempKey, cacheData, { EX: 86400 }).catch(console.error);
                return originalJson.call(this, body);
            };
        }

        const securePlan = req.header('x-derived-plan') || 'free';
        req.headers['x-plan'] = securePlan;
        
        return next();
      }
      return res.status(401).json({ success: false, message: 'Unauthorized: Invalid or missing API key.' });
    },
    attachIdentityContext,
    progressiveFrictionEngine
  ];

  app.use(express.json({
    verify: (req: express.Request, res, buf) => {
      req.rawBody = buf;
    }
  }));

  app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
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
    const isV1 = req.path.startsWith('/v1');
    const isDomains = req.path === '/domains' || req.path.startsWith('/domains/');
    if (isV1 || isDomains) return next();

    let i = 0;
    const executeNext = (err?: any) => {
      if (err) return next(err);
      if (i < internalApiAuth.length) {
        (internalApiAuth[i++] as express.RequestHandler)(req, res, executeNext);
      } else {
        next();
      }
    };
    executeNext();
  });

  const server = createServer(app);

  // ── WebSocket server in noServer mode ──────────────────────────────────────
  // noServer: true means the ws library does NOT attach its own 'upgrade'
  // listener. We manually route upgrades below so /v1/ws and the internal
  // mailbox socket are handled separately — this is what prevents the
  // "bad handshake" error on /v1/ws.
  const wss = new WebSocket.Server({ noServer: true });

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
  app.delete('/user/inboxes', deleteInboxHandler);
  app.get('/user/inbox-notes', getInboxNotesHandler);
  app.post('/user/inbox-notes', upsertInboxNoteHandler);
  app.delete('/user/inbox-notes', deleteInboxNoteHandler);

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
  app.get('/domains/expiry', domainExpiryHandler);

  app.get('/health', statsHandler);
  app.get('/user/api-status/:wyiUserId', getApiStatusHandler);

  // ── Public Developer API ───────────────────────────────────────────────────
  app.use('/v1/market', require('./v1/market-router').default);
  app.use('/v1', createPublicV1Router());

  // ── In-memory mailbox client registry (internal WS) ───────────────────────
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

  function notifyMailbox(mailbox: string, event: any) {
    const clients = mailboxClients[mailbox];
    if (!clients) return;
    const message = JSON.stringify(event);
    clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(message); });
  }

  // ── Internal mailbox WS connection handler ─────────────────────────────────
  // JWT validation is done in the upgrade handler below before we get here,
  // so mailbox is guaranteed to be valid at this point.
  wss.on('connection', (ws: WebSocket, req) => {
    const urlParams = new URLSearchParams(req.url?.split('?')[1] ?? '');
    const mailbox = urlParams.get('mailbox')!; // validated in upgrade handler

    if (!mailboxClients[mailbox]) mailboxClients[mailbox] = new Set();
    mailboxClients[mailbox].add(ws);
    if (mailbox === 'stats') sendStatsToAllStatsClients();

    ws.on('close', () => {
      mailboxClients[mailbox]?.delete(ws);
      if (mailboxClients[mailbox]?.size === 0) delete mailboxClients[mailbox];
    });
  });

  // ── HTTP Upgrade router ────────────────────────────────────────────────────
  // This is the critical fix: we intercept ALL upgrade requests here and route
  // them explicitly instead of letting the ws library grab everything blindly.
  server.on('upgrade', (request, socket, head) => {
    const url = request.url ?? '';

    // ── Route 1: Public developer API WebSocket (/v1/ws) ──────────────────
    if (url.startsWith('/v1/ws')) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        // handleApiWebSocket does its own auth (API key), plan gate, etc.
        handleApiWebSocket(ws, request);
      });
      return;
    }

    // ── Route 2: Internal mailbox WebSocket (JWT-gated) ───────────────────
    const urlParams = new URLSearchParams(url.split('?')[1] ?? '');
    const mailbox   = urlParams.get('mailbox');
    const wsToken   = urlParams.get('token');

    if (!mailbox) {
      socket.write('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }

    // Validate JWT before completing the handshake — reject here so the
    // client sees a clean HTTP error rather than a post-connect close frame.
    try {
      const decoded = jwt.verify(wsToken ?? '', process.env.JWT_SECRET!) as jwt.JwtPayload;
      if (decoded.mailbox !== mailbox) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
        socket.destroy();
        return;
      }
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }

    // Handshake is valid — complete upgrade and emit 'connection'
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  // ── Redis pub/sub ──────────────────────────────────────────────────────────
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