// /api/src/delete-inbox-handler.ts
import { Request, Response } from 'express';
import { db } from '../config/mongo';
import { client as redisClient } from '../config/redis';

/**
 * DELETE /user/inboxes
 * Body: { wyiUserId: string; inbox: string }
 *
 * Removes a single inbox from the user's saved inbox list.
 * Also invalidates the Redis plan cache entry for that address.
 */
export async function deleteInboxHandler(req: Request, res: Response): Promise<any> {
  const { wyiUserId, inbox } = req.body;

  if (!wyiUserId || !inbox) {
    return res.status(400).json({ success: false, message: 'wyiUserId and inbox are required.' });
  }

  const normalizedInbox = String(inbox).trim().toLowerCase();

  try {
    const user = await db.collection('users').findOne(
      { $or: [{ wyiUserId }, { linkedProviderIds: wyiUserId }] },
      { projection: { _id: 1, inboxes: 1 } },
    );

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    await db.collection('users').updateOne(
      { _id: user._id },
      { $pull: { inboxes: normalizedInbox } } as any,
    );

    // ── Invalidate Redis plan-cache entry for this address ─────────────────
    if (redisClient.isOpen) {
      redisClient
        .del(`user_data_cache:${normalizedInbox}`)
        .catch((err) => console.error('[delete-inbox] Redis del error:', err));
    }

    return res.json({ success: true, message: 'Inbox removed.' });
  } catch (err) {
    console.error('[delete-inbox] error:', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
}