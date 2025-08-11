// /home/dit/maildrop/api/src/server.ts
import express from 'express';
import { createServer } from 'http';
import WebSocket from 'ws';
import { listHandler, messageHandler, deleteHandler } from './mailbox';
import { getStats, statsHandler } from './statistics';
import { subscriber } from './redis';  // Import Redis subscriber
import dotenv from 'dotenv';
import { connectToMongo } from './mongo';
import { addDomainHandler, getDomainsHandler, getUserProfileHandler, muteSenderHandler, upsertUserHandler } from './user';
import { deleteDomainHandler, getDashboardDataHandler, unmuteSenderHandler, verifyDomainHandler } from './domain-handler';

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
    res.status(401).json({ success: false, message: 'Unauthorized' });
  };

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

  app.use(express.json());

  // --- API Routes ---
  app.get('/mailbox/:name', listHandler);
  app.get('/mailbox/:name/message/:id', messageHandler);
  app.delete('/mailbox/:name/message/:id', deleteHandler);
  app.get('/health', statsHandler);
  app.post('/auth/upsert-user', upsertUserHandler);
  app.get('/user/profile/:wyiUserId', getUserProfileHandler);
  app.get('/user/:wyiUserId/dashboard-data', getDashboardDataHandler);
  app.delete('/user/domains', deleteDomainHandler);
  app.post('/user/domains/verify', verifyDomainHandler);
  app.delete('/user/mute', unmuteSenderHandler);
  app.get('/user/:wyiUserId/domains', getDomainsHandler);
  app.post('/user/domains', addDomainHandler);
  app.post('/user/mute', muteSenderHandler);

  // --- WebSocket Logic ---
  
  const mailboxClients: Record<string, Set<WebSocket>> = {};

  /**
   * Fetches the latest stats and sends them to all connected 'stats' clients.
   * This is now the single source of truth for sending stats updates.
   */
  async function sendStatsToAllStatsClients() {
    // Check if there are any stats clients to avoid doing work unnecessarily
    const statsClients = mailboxClients["stats"];
    if (!statsClients || statsClients.size === 0) {
      return;
    }
  
    try {
      const [queued, denied] = await Promise.all([
        getStats("queued"),
        getStats("denied"),
      ]);
  
      const statsPayload = JSON.stringify({
        type: "stats",
        queued,
        denied,
      });
  
      for (const ws of statsClients) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(statsPayload);
        }
      }
    } catch (err) {
      console.error('Error fetching or sending stats via WS:', err);
    }
  }
  
  wss.on('connection', (ws: WebSocket, req) => {
    // Gracefully handle missing req.url
    const url = req.url || '';
    const mailbox = new URLSearchParams(url.split('?')[1]).get('mailbox');
  
    if (!mailbox) {
      console.log('WS connection rejected: missing mailbox parameter.');
      ws.close();
      return;
    }
  
    if (!mailboxClients[mailbox]) {
      mailboxClients[mailbox] = new Set();
    }
    mailboxClients[mailbox].add(ws);
    console.log(`Client connected to mailbox: ${mailbox}. Total clients for this mailbox: ${mailboxClients[mailbox].size}`);
  
    // --- FIX 1: SEND INITIAL STATE ON CONNECTION ---
    // If a client connects to the special 'stats' mailbox, immediately send them the current stats.
    if (mailbox === 'stats') {
      console.log("New 'stats' client connected. Sending current stats.");
      sendStatsToAllStatsClients();
    }
  
    ws.on('close', () => {
      if (mailboxClients[mailbox]) {
        mailboxClients[mailbox].delete(ws);
        console.log(`Client disconnected from mailbox: ${mailbox}. Remaining: ${mailboxClients[mailbox].size}`);
        if (mailboxClients[mailbox].size === 0) {
          delete mailboxClients[mailbox];
          console.log(`All clients for mailbox ${mailbox} disconnected. Cleaning up.`);
        }
      }
    });
  });
  
  function notifyMailbox(mailbox: string, event: any) {
    const clients = mailboxClients[mailbox];
    if (clients) {
      const message = JSON.stringify(event);
      for (const ws of clients) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(message);
        }
      }
    }
  }
  
  // --- Redis Pub/Sub Listeners ---
  (async () => {
    // Listener for NEW MAIL events (from Haraka)
    await subscriber.pSubscribe('mailbox:events:*', (message, channel) => {
      try {
        const event = JSON.parse(message);
        const mailbox = channel.split(':')[2]; // e.g., from "mailbox:events:user@example.com"
        notifyMailbox(mailbox, event);
      } catch (e) {
        console.error('Failed to handle new mail pub/sub message:', e);
      }
    });
  
    // --- FIX 2: LISTEN TO KEY CHANGES FOR RELIABLE STATS ---
    // This is the most robust way to detect stat changes. It will fire whenever
    // `stats:queued` or `stats:denied` is set or incremented, no matter how.
    await subscriber.pSubscribe('__keyevent@*__:set', async (message, channel) => {
        // The message for a 'set' event is the key that was set.
        const key = message;
        if (key === 'stats:queued' || key === 'stats:denied') {
            console.log(`Detected change in stats key: '${key}'. Broadcasting update.`);
            await sendStatsToAllStatsClients();
        }
    });
  
  })();
  
  server.listen(PORT, () => {
    console.log(`Server + WS running on http://localhost:${PORT}`);
  });
});