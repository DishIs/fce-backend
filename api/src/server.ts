// /home/dit/maildrop/api/src/server.ts
import express from 'express';
import { createServer } from 'http';
import WebSocket from 'ws';
import { listHandler, messageHandler, deleteHandler } from './mailbox';
import { getStats, statsHandler } from './statistics';
import { subscriber } from './redis';
import dotenv from 'dotenv';
import { connectToMongo } from './mongo';
import { addDomainHandler, getDomainsHandler, getUserProfileHandler, muteSenderHandler, upsertUserHandler } from './user';
import { deleteDomainHandler, getDashboardDataHandler, unmuteSenderHandler, verifyDomainHandler } from './domain-handler';
import { addInboxHandler } from './inbox-handler';

dotenv.config();

connectToMongo().then(() => {
  const app = express();
  const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;

  if (!INTERNAL_API_KEY) {
    throw new Error("FATAL: INTERNAL_API_KEY is not set. The service cannot run securely.");
  }
  
  const internalApiAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    // Express automatically lowercases header names
    const providedKey = req.header('x-internal-api-key');
    if (providedKey && providedKey === INTERNAL_API_KEY) {
      return next();
    }
    // Return to prevent further execution
    return res.status(401).json({ success: false, message: 'Unauthorized: Invalid or missing API key.' });
  };

  // --- CORRECT MIDDLEWARE ORDER ---

  // 1. Register the body parser first to handle all incoming request bodies.
  app.use(express.json());

  // 2. Register your authentication middleware next.
  // It will apply to all routes defined after this point.
  app.use((req, res, next) => {
    // If the request is a WebSocket upgrade, skip API key authentication.
    if (req.headers.upgrade && req.headers.upgrade.toLowerCase() === 'websocket') {
      next();
    } else {
      // Otherwise, enforce the internal API key check.
      internalApiAuth(req, res, next);
    }
  });

  const server = createServer(app);
  const wss = new WebSocket.Server({ server });
  const PORT = process.env.PORT || 3000;


  // --- API Routes ---
  // These routes are now protected by the middleware above.
  app.get('/mailbox/:name', listHandler);
  app.get('/mailbox/:name/message/:id', messageHandler);
  app.delete('/mailbox/:name/message/:id', deleteHandler);
  app.post('/auth/upsert-user', upsertUserHandler);
  app.get('/user/profile/:wyiUserId', getUserProfileHandler);
  app.get('/user/:wyiUserId/dashboard-data', getDashboardDataHandler);
  app.delete('/user/domains', deleteDomainHandler);
  app.post('/user/domains/verify', verifyDomainHandler);
  app.delete('/user/mute', unmuteSenderHandler);
  app.get('/user/:wyiUserId/domains', getDomainsHandler);
  app.post('/user/domains', addDomainHandler);
  app.post('/user/mute', muteSenderHandler);
  app.post('/user/inboxes', addInboxHandler);
  
  // The /health route is also protected by the key. If you want it to be public,
  // move it ABOVE the app.use(internalApiAuth) block.
  app.get('/health', statsHandler);


  // --- WebSocket Logic (remains unchanged) ---
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
    const url = req.url || '';
    const mailbox = new URLSearchParams(url.split('?')[1]).get('mailbox');
  
    if (!mailbox) {
      ws.close();
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