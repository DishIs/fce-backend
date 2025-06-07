import express from 'express';
import { createServer } from 'http';
import WebSocket from 'ws';
import { listHandler, messageHandler, deleteHandler } from './mailbox';
import { statsHandler } from './statistics';

const app = express();
const server = createServer(app);
const wss = new WebSocket.Server({ server }); // Attach WS to HTTP server

const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get('/mailbox/:name', listHandler);
app.get('/mailbox/:name/message/:id', messageHandler);
app.delete('/mailbox/:name/message/:id', deleteHandler);
app.get('/health', statsHandler);

// Store WS clients by mailbox name
const mailboxClients: Record<string, Set<WebSocket>> = {};

interface MailboxClients {
  [mailbox: string]: Set<WebSocket>;
}

interface MailboxConnectionRequest extends Request {
  url: string;
}

wss.on('connection', (ws: WebSocket, req: MailboxConnectionRequest) => {
  const mailbox: string | null = new URLSearchParams(req.url?.split('?')[1]).get('mailbox');
  if (!mailbox) {
    ws.close();
    return;
  }

  if (!mailboxClients[mailbox]) mailboxClients[mailbox] = new Set<WebSocket>();
  mailboxClients[mailbox].add(ws);

  ws.on('close', () => mailboxClients[mailbox].delete(ws));
});

// Export a method to notify mailbox clients
export function notifyMailbox(mailbox: string, event: any) {
  const clients = mailboxClients[mailbox];
  if (clients) {
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(event));
      }
    }
  }
}

// Start server
server.listen(PORT, () => {
  console.log(`Server + WS running on http://localhost:${PORT}`);
});
