// api/src/handlers/inbox-notes-handler.ts
import { Request, Response } from 'express';
import { db } from '../config/mongo';
import { client as redisClient } from '../config/redis';

const FREE_NOTE_CHAR_LIMIT = 100;
const PRO_NOTE_CHAR_LIMIT  = 500;
const REDIS_TTL_SECONDS    = 60 * 60 * 24 * 30; // 30 days

const toRedisKey = (userId: string) => `inbox_notes:${userId}`;

// ── Shared helper ─────────────────────────────────────────────────────────────
async function warmRedisFromDB(userId: string): Promise<Record<string, string>> {
  const user = await db.collection('users').findOne(
    { $or: [{ wyiUserId: userId }, { linkedProviderIds: userId }] },
    { projection: { inboxNotes: 1 } },
  );

  const notes: Record<string, string> = {};
  if (Array.isArray(user?.inboxNotes)) {
    for (const entry of user.inboxNotes) {
      if (entry?.inbox && entry?.note != null) notes[entry.inbox] = entry.note;
    }
  }

  if (redisClient.isOpen) {
    redisClient
      .set(toRedisKey(userId), JSON.stringify(notes), { EX: REDIS_TTL_SECONDS })
      .catch((err) => console.error('[inbox-notes] Redis warm error:', err));
  }

  return notes;
}

// ── GET /user/inbox-notes?wyiUserId=xxx ───────────────────────────────────────
export async function getInboxNotesHandler(req: Request, res: Response): Promise<any> {
  const wyiUserId = req.query.wyiUserId as string;
  if (!wyiUserId) {
    return res.status(400).json({ success: false, message: 'wyiUserId is required.' });
  }

  try {
    // 1️⃣  Redis cache hit (fast path)
    if (redisClient.isOpen) {
      const cached = await redisClient.get(toRedisKey(wyiUserId)).catch(() => null);
      if (cached) {
        return res.json({ success: true, notes: JSON.parse(cached) });
      }
    }

    // 2️⃣  Miss → read DB and populate Redis
    const notes = await warmRedisFromDB(wyiUserId);
    return res.json({ success: true, notes });
  } catch (err) {
    console.error('[inbox-notes] GET error:', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
}

// ── POST /user/inbox-notes  { wyiUserId, inbox, note } ───────────────────────
export async function upsertInboxNoteHandler(req: Request, res: Response): Promise<any> {
  const { wyiUserId, inbox, note } = req.body;

  if (!wyiUserId || !inbox) {
    return res.status(400).json({ success: false, message: 'wyiUserId and inbox are required.' });
  }

  try {
    const user = await db.collection('users').findOne(
      { $or: [{ wyiUserId }, { linkedProviderIds: wyiUserId }] },
      { projection: { plan: 1, _id: 1 } },
    );
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    const isPro   = user.plan === 'pro';
    const limit   = isPro ? PRO_NOTE_CHAR_LIMIT : FREE_NOTE_CHAR_LIMIT;
    const trimmed = String(note ?? '').trim().slice(0, limit);

    // ── MongoDB upsert ─────────────────────────────────────────────────────
    // Try updating an existing entry first; fall back to $push if none.
    const updateResult = await db.collection('users').updateOne(
      { _id: user._id, 'inboxNotes.inbox': inbox },
      { $set: { 'inboxNotes.$.note': trimmed } },
    );

    if (updateResult.matchedCount === 0) {
      await db.collection('users').updateOne(
        { _id: user._id },
        { $push: { inboxNotes: { inbox, note: trimmed } } } as any,
      );
    }

    // ── Redis update (fire-and-forget) ─────────────────────────────────────
    if (redisClient.isOpen) {
      const key    = toRedisKey(wyiUserId);
      const cached = await redisClient.get(key).catch(() => null);
      const map: Record<string, string> = cached ? JSON.parse(cached) : {};
      map[inbox] = trimmed;
      redisClient
        .set(key, JSON.stringify(map), { EX: REDIS_TTL_SECONDS })
        .catch((err) => console.error('[inbox-notes] Redis upsert error:', err));
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('[inbox-notes] POST error:', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
}

// ── DELETE /user/inbox-notes  { wyiUserId, inbox } ───────────────────────────
export async function deleteInboxNoteHandler(req: Request, res: Response): Promise<any> {
  const { wyiUserId, inbox } = req.body;

  if (!wyiUserId || !inbox) {
    return res.status(400).json({ success: false, message: 'wyiUserId and inbox are required.' });
  }

  try {
    const user = await db.collection('users').findOne(
      { $or: [{ wyiUserId }, { linkedProviderIds: wyiUserId }] },
      { projection: { _id: 1 } },
    );
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    await db.collection('users').updateOne(
      { _id: user._id },
      { $pull: { inboxNotes: { inbox } } } as any,
    );

    // ── Redis update (fire-and-forget) ─────────────────────────────────────
    if (redisClient.isOpen) {
      const key    = toRedisKey(wyiUserId);
      const cached = await redisClient.get(key).catch(() => null);
      if (cached) {
        const map: Record<string, string> = JSON.parse(cached);
        delete map[inbox];
        redisClient
          .set(key, JSON.stringify(map), { EX: REDIS_TTL_SECONDS })
          .catch((err) => console.error('[inbox-notes] Redis delete error:', err));
      }
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('[inbox-notes] DELETE error:', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
}