import express from 'express';
import { createServer } from 'https';
import fs from 'fs';
import WebSocket from 'ws';
import { listHandler, messageHandler, deleteHandler } from './mailbox';
import { statsHandler } from './statistics';
import { subscriber } from './redis';  // Import Redis subscriber

const app = express();
const server = createServer({
  key: fs.readFileSync('/home/ubuntu/ssl/privkey.pem'),
  cert: fs.readFileSync('/home/ubuntu/ssl/fullchain.pem'),
}, app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get('/mailbox/:name', listHandler);
app.get('/mailbox/:name/message/:id', messageHandler);
app.delete('/mailbox/:name/message/:id', deleteHandler);
app.get('/health', statsHandler);

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
  await subscriber.pSubscribe('mailbox:events:*', (message, channel) => {
    try {
      const event = JSON.parse(message);
      const mailbox = channel.split(':')[2]; // Extract mailbox from channel name
      notifyMailbox(mailbox, event);
    } catch (e) {
      console.error('Failed to parse Redis pubsub message', e);
    }
  });
})();

server.listen(PORT, () => {
  console.log(`Server + WS running on http://localhost:${PORT}`);
});
