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
  saveFcmTokenHandler
} from './user';
import { deleteDomainHandler, getDashboardDataHandler, verifyDomainHandler } from './domain-handler';
import { addInboxHandler } from './inbox-handler';
import { domainsHandler } from './domains';
import { handlePaddleSubscriptionEvent } from './paddle-handler';
import jwt from 'jsonwebtoken';


dotenv.config();

connectToMongo().then(() => {
  const app = express();
  const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;

  if (!INTERNAL_API_KEY) {
    throw new Error("FATAL: INTERNAL_API_KEY is not set. The service cannot run securely.");
  }

  const internalApiAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const providedKey = req.header('x-internal-api-key');
    if (providedKey && providedKey === INTERNAL_API_KEY) {
      return next();
    }
    return res.status(401).json({ success: false, message: 'Unauthorized: Invalid or missing API key.' });
  };

  app.use(express.json());

  app.use((req, res, next) => {
    if (req.headers.upgrade && req.headers.upgrade.toLowerCase() === 'websocket') {
      next();
    } else {
      internalApiAuth(req, res, next);
    }
  });

  const server = createServer(app);
  const wss = new WebSocket.Server({ server });
  const PORT = process.env.PORT || 3000;

  // --- API Routes ---

  // Public Mailbox Routes (Protected by API Key, accessed by Frontend)
  app.get('/mailbox/:name', listHandler);
  app.get('/mailbox/:name/message/:id', messageHandler);
  app.delete('/mailbox/:name/message/:id', deleteHandler);

  // Auth & User Lifecycle
  app.post('/auth/upsert-user', upsertUserHandler);
  app.post('/user/status', getUserStatusHandler); // NEW: Get Plan/Sub status
  app.get('/user/profile/:wyiUserId', getUserProfileHandler);

  // Settings & Dashboard
  app.post('/user/settings', updateSettingsHandler); // NEW: Update Settings
  app.post('/user/get-settings', getSettingsHandler); // NEW: Get Settings
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
  app.post('/user/fcm-token', saveFcmTokenHandler); // <--- ADD THIS LINE


  // Billing (Internal/NextJS callback)
  app.post('/user/upgrade', upgradeUserSubscriptionHandler); // NEW: Upgrade to Pro

  // Paddle webhook event relay
  app.post('/paddle/subscription-event', handlePaddleSubscriptionEvent);

  app.get('/domains', domainsHandler);

  // Health
  app.get('/health', statsHandler);


  // --- WebSocket Logic ---
  const mailboxClients: Record<string, Set<WebSocket>> = {};

  async function sendStatsToAllStatsClients() {
    const statsClients = mailboxClients["stats"];
    if (!statsClients || statsClients.size === 0) return;

    try {
      const [queued, denied] = await Promise.all([getStats("queued"), getStats("denied")]);
      const statsPayload = JSON.stringify({ type: "stats", queued, denied });
      for (const ws of statsClients) {
        if (ws.readyState === WebSocket.OPEN) ws.send(statsPayload);
      }
    } catch (err) {
      console.error('Error fetching or sending stats via WS:', err);
    }
  }

  wss.on('connection', (ws: WebSocket, req) => {
    const urlParams = new URLSearchParams(req.url?.split('?')[1] ?? '');
    const mailbox = urlParams.get('mailbox');
    const wsToken = urlParams.get('token');

    if (!mailbox) { ws.close(1008, 'Missing mailbox'); return; }

    // Verify the ticket
    try {
      const decoded = jwt.verify(wsToken ?? '', process.env.JWT_SECRET!) as jwt.JwtPayload;

      // Ensure the token was issued for THIS mailbox — prevents token reuse
      if (decoded.mailbox !== mailbox) {
        ws.close(1008, 'Token mailbox mismatch');
        return;
      }
    } catch (err) {
      ws.close(1008, 'Unauthorized');
      return;
    }


    if (!mailboxClients[mailbox]) mailboxClients[mailbox] = new Set();
    mailboxClients[mailbox].add(ws);

    if (mailbox === 'stats') {
      sendStatsToAllStatsClients();
    }

    ws.on('close', () => {
      if (mailboxClients[mailbox]) {
        mailboxClients[mailbox].delete(ws);
        if (mailboxClients[mailbox].size === 0) delete mailboxClients[mailbox];
      }
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
        notifyMailbox(mailbox, event);
      } catch (e) {
        console.error('Failed to handle new mail pub/sub message:', e);
      }
    });

    await subscriber.pSubscribe('__keyevent@*__:set', async (message, channel) => {
      const key = message;
      if (key === 'stats:queued' || key === 'stats:denied') {
        await sendStatsToAllStatsClients();
      }
    });
  })();

  server.listen(PORT, () => {
    console.log(`Server + WS running on http://localhost:${PORT}`);
  });
});