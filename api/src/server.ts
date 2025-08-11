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

  // --- NEW: Security Middleware ---
  // This middleware will run on ALL incoming requests to this service.
  const internalApiAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const providedKey = req.header('x-internal-api-key');
    if (providedKey && providedKey === INTERNAL_API_KEY) {
      // Key is valid, proceed to the actual route handler
      return next();
    }
    // Key is missing or invalid
    res.status(401).json({ success: false, message: 'Unauthorized' });
  };

  // Apply the middleware to all routes
  app.use(internalApiAuth);

  const server = createServer(app);
  const wss = new WebSocket.Server({ server });

  const PORT = process.env.PORT || 3000;

  app.use(express.json());

  app.get('/mailbox/:name', listHandler);
  app.get('/mailbox/:name/message/:id', messageHandler);
  app.delete('/mailbox/:name/message/:id', deleteHandler);
  app.get('/health', statsHandler);


  // --- NEW AUTH ROUTE ---
  app.post('/auth/upsert-user', upsertUserHandler);
  app.get('/user/profile/:wyiUserId', getUserProfileHandler);


  // Define routes WITH the implemented handlers
  app.get('/user/:wyiUserId/dashboard-data', getDashboardDataHandler);
  app.delete('/user/domains', deleteDomainHandler);
  app.post('/user/domains/verify', verifyDomainHandler);
  app.delete('/user/mute', unmuteSenderHandler);
  // NEW Routes for Pro Features
  app.get('/user/:wyiUserId/domains', getDomainsHandler);
  app.post('/user/domains', addDomainHandler);
  app.post('/user/mute', muteSenderHandler);

  async function sendStatsToStatsClientsOnly() {
    try {
      const [queued, denied] = await Promise.all([
        getStats("queued"),
        getStats("denied"),
      ]);

      const statsPayload = {
        type: "stats",
        queued,
        denied,
      };

      const statsClients = mailboxClients["stats"];
      if (statsClients) {
        for (const ws of statsClients) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(statsPayload));
          }
        }
      }
    } catch (err) {
      console.error('Error fetching or sending stats via WS:', err);
    }
  }



  const mailboxClients: Record<string, Set<WebSocket>> = {};

  wss.on('connection', (ws: WebSocket, req) => {
    const mailbox = new URLSearchParams(req.url?.split('?')[1]).get('mailbox');
    if (!mailbox) {
      ws.close();
      return;
    }

    if (!mailboxClients[mailbox]) mailboxClients[mailbox] = new Set();
    mailboxClients[mailbox].add(ws);

    ws.on('close', () => {
      mailboxClients[mailbox].delete(ws);
      if (mailboxClients[mailbox].size === 0) {
        delete mailboxClients[mailbox];
      }
    });
  });

  function notifyMailbox(mailbox: string, event: any) {
    const clients = mailboxClients[mailbox];
    if (clients) {
      for (const ws of clients) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(event));
        }
      }
    }
  }

  // Subscribe to all mailbox event channels (pattern subscribe)
  (async () => {
    await subscriber.pSubscribe('mailbox:events:*', async (message, channel) => {
      try {
        const event = JSON.parse(message);
        const mailbox = channel.split(':')[2]; // mailbox:events:<mailbox>

        notifyMailbox(mailbox, event);     // send new mail event
        await sendStatsToStatsClientsOnly();     // send updated stats to all
      } catch (e) {
        console.error('Failed to handle pubsub message:', e);
      }
    });

  })();

  server.listen(PORT, () => {
    console.log(`Server + WS running on http://localhost:${PORT}`);
  });
});