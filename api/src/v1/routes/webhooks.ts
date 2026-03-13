// v1/routes/webhooks.ts
// ─────────────────────────────────────────────────────────────────────────────
//  Webhook subscription management for Make.com (and any other platform).
//
//  POST   /v1/webhooks          — register a webhook (attach)
//  DELETE /v1/webhooks/:id      — unregister a webhook (detach)
//  GET    /v1/webhooks          — list active webhooks for this user
//
//  When a new email arrives, notifyWebhooks() is called from the Redis
//  pub/sub handler (same place notifyApiWsClients is called in server.ts).
// ─────────────────────────────────────────────────────────────────────────────
import { Router, Request, Response } from 'express';
import { db } from '../../mongo';
import { ObjectId } from 'mongodb';

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/webhooks — register (Make calls this on "attach")
// Body: { url: string, inbox: string }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', async (req: Request, res: Response): Promise<any> => {
  const { url, inbox } = req.body;
  const apiUser = req.apiUser!;

  if (!url || !inbox) {
    return res.status(400).json({
      success: false,
      error: 'missing_fields',
      message: '`url` and `inbox` are required.',
    });
  }

  // Verify ownership of the inbox
  const user = await db.collection('users').findOne({
    wyiUserId: apiUser.userId,
    apiInboxes: inbox.toLowerCase(),
  });

  if (!user) {
    return res.status(403).json({
      success: false,
      error: 'inbox_not_owned',
      message: `Inbox "${inbox}" is not registered. POST /v1/inboxes first.`,
    });
  }

  try {
    const doc = {
      wyiUserId:  apiUser.userId,
      inbox:      inbox.toLowerCase(),
      url,
      createdAt:  new Date(),
      active:     true,
    };

    const result = await db.collection('webhooks').insertOne(doc);

    return res.status(201).json({
      success: true,
      id:      result.insertedId.toString(),
      inbox:   doc.inbox,
      url:     doc.url,
    });
  } catch {
    return res.status(500).json({ success: false, error: 'server_error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /v1/webhooks/:id — unregister (Make calls this on "detach")
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/:id', async (req: Request, res: Response): Promise<any> => {
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
        error: 'not_found',
        message: 'Webhook not found or does not belong to this account.',
      });
    }

    return res.json({ success: true, message: 'Webhook unregistered.' });
  } catch {
    return res.status(500).json({ success: false, error: 'server_error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /v1/webhooks — list (useful for debugging)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', async (req: Request, res: Response): Promise<any> => {
  const apiUser = req.apiUser!;
  try {
    const hooks = await db
      .collection('webhooks')
      .find({ wyiUserId: apiUser.userId, active: true }, { projection: { _id: 1, inbox: 1, url: 1, createdAt: 1 } })
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
    fetch(hook.url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    payload,
      signal:  AbortSignal.timeout(10_000), // 10s timeout per delivery
    }).catch((err) => {
      console.error(`[webhooks] Delivery failed for hook ${hook._id}:`, err.message);
      // Optionally: increment a failure counter and auto-disable after N failures
    });
  }
}