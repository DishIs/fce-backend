// api/src/upgrade-migration.ts
// Called whenever a user is upgraded to 'pro'.
// Mirrors exactly how the SMTP plugin (queue.redis.js) stores emails.
//
// What it does per inbox:
//  1. Reads all messages from maildrop:free:{inbox}:* and maildrop:anonymous:{inbox}:*
//  2. Copies them into maildrop:pro:{inbox}:* with NO TTL (pro emails live forever)
//  3. Saves each message to MongoDB saved_emails (skipping duplicates)
//  4. Deletes the old free/anonymous Redis keys for those inboxes
//  5. Updates user_data_cache for every inbox so the SMTP plugin sees 'pro' immediately

import { client } from './redis';
import { db } from './mongo';
import { ObjectId } from 'mongodb';

// ─────────────────────────────────────────────────────────────────────────────
// Types (mirror the SMTP plugin's fullMessage shape)
// ─────────────────────────────────────────────────────────────────────────────

interface RedisMessage {
  id:                  string;
  from:                string;
  to:                  string;
  subject:             string;
  date:                string;
  hasAttachment:       boolean;
  wasAttachmentStripped?: boolean;
  html?:               string;
  text?:               string;
  attachments?:        any[];
  otp?:                string | null;
  verificationLink?:   string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core migration for a single inbox
// ─────────────────────────────────────────────────────────────────────────────

async function migrateInboxToPro(
  mailbox:  string,
  userId:   ObjectId,
  plansToDrain: Array<'free' | 'anonymous'>
): Promise<number> {
  const proIndexKey = `maildrop:pro:${mailbox}:index`;
  const proDataKey  = `maildrop:pro:${mailbox}:data`;

  // Collect all messages from free + anonymous keys
  const allMessages: Array<{ score: number; message: RedisMessage }> = [];

  for (const plan of plansToDrain) {
    const srcIndex = `maildrop:${plan}:${mailbox}:index`;
    const srcData  = `maildrop:${plan}:${mailbox}:data`;

    // zRangeWithScores returns [{value, score}, ...]
    const entries = await client.zRangeWithScores(srcIndex, 0, -1);
    if (!entries || entries.length === 0) continue;

    const ids = entries.map(e => e.value);
    const rawMessages = await client.hmGet(srcData, ids);

    for (let i = 0; i < entries.length; i++) {
      const raw = rawMessages[i];
      if (!raw) continue;
      try {
        allMessages.push({
          score:   entries[i].score,
          message: JSON.parse(raw) as RedisMessage,
        });
      } catch {
        // corrupt entry — skip
      }
    }
  }

  if (allMessages.length === 0) return 0;

  // Deduplicate against what's already in the pro key
  const existingProIds = new Set(
    await client.zRange(proIndexKey, 0, -1)
  );

  const toMigrate = allMessages.filter(m => !existingProIds.has(m.message.id));
  if (toMigrate.length === 0) return 0;

  // ── 1. Write to pro Redis keys (no TTL) ────────────────────────────────────
  const multi = client.multi();
  for (const { score, message } of toMigrate) {
    // Promote OTP/verificationLink from teaser to real value where possible.
    // The real values aren't re-extractable from Redis alone (HTML not always stored),
    // so we keep whatever is there — free users had '__DETECTED__' teasers, pro users
    // will see the actual value from MongoDB going forward.
    multi.zAdd(proIndexKey, { score, value: message.id });
    multi.hSet(proDataKey, message.id, JSON.stringify(message));
  }
  // No expire — pro emails persist indefinitely
  await multi.exec();

  // ── 2. Upsert into MongoDB saved_emails ────────────────────────────────────
  // Mirror the shape the SMTP plugin uses for cfg.save_to_mongo
  const mongoOps = toMigrate.map(({ message }) => ({
    updateOne: {
      filter: { mailbox, messageId: message.id },
      update: {
        $setOnInsert: {
          userId,
          mailbox,
          messageId:   message.id,
          from:        message.from,
          to:          message.to ? [{ address: message.to }] : [],
          subject:     message.subject,
          date:        new Date(message.date),
          html:        message.html   ?? null,
          text:        message.text   ?? null,
          // Attachments: redis messages may have inline base64 content;
          // we store them as-is. GridFS migration is not attempted here
          // (attachments from free/anon are already inline base64 if present).
          attachments: (message.attachments ?? []).map(att => ({
            filename:    att.filename,
            contentType: att.contentType,
            size:        att.size,
            // gridfs_id omitted — inline content kept if present
            ...(att.content ? { content: att.content } : {}),
          })),
          otp:              message.otp   ?? null,
          verificationLink: message.verificationLink ?? null,
          storageUsed:      0, // attachments were already stripped/counted at ingest
          migratedAt:       new Date(),
        },
      },
      upsert: true,
    },
  }));

  if (mongoOps.length > 0) {
    try {
      await db.collection('saved_emails').bulkWrite(mongoOps, { ordered: false });
    } catch (err) {
      console.error(`[upgrade-migration] MongoDB bulkWrite failed for ${mailbox}:`, err);
      // Non-fatal — Redis migration already done
    }
  }

  // ── 3. Delete old free/anonymous keys for this inbox ──────────────────────
  const delMulti = client.multi();
  for (const plan of plansToDrain) {
    delMulti.del(`maildrop:${plan}:${mailbox}:index`);
    delMulti.del(`maildrop:${plan}:${mailbox}:data`);
  }
  await delMulti.exec();

  return toMigrate.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Update user_data_cache so the SMTP plugin immediately treats these
// inboxes as 'pro' without waiting for the TTL to expire
// ─────────────────────────────────────────────────────────────────────────────

async function refreshPlanCache(
  inboxes:  string[],
  userId:   ObjectId,
  ttl = 3600
): Promise<void> {
  if (!client.isOpen) return;

  const userData = JSON.stringify({
    plan:       'pro',
    userId:     userId.toString(),
    isVerified: false,
  });

  const multi = client.multi();
  for (const inbox of inboxes) {
    multi.set(`user_data_cache:${inbox}`, userData, { EX: ttl });
  }
  await multi.exec();
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry point — call this inside the ACTIVATED handler
// ─────────────────────────────────────────────────────────────────────────────

export async function migrateUserEmailsToPro(wyiUserId: string): Promise<void> {
  // 1. Fetch the user so we have their _id and inboxes list
  const user = await db.collection('users').findOne({
    $or: [
      { wyiUserId },
      { linkedProviderIds: wyiUserId },
    ],
  });

  if (!user) {
    console.warn(`[upgrade-migration] User not found for wyiUserId=${wyiUserId}`);
    return;
  }

  const inboxes: string[] = Array.isArray(user.inboxes) ? user.inboxes : [];
  if (inboxes.length === 0) {
    console.log(`[upgrade-migration] No inboxes to migrate for ${wyiUserId}`);
    return;
  }

  const userId = user._id as ObjectId;
  let totalMigrated = 0;

  for (const inbox of inboxes) {
    try {
      const count = await migrateInboxToPro(inbox, userId, ['free', 'anonymous']);
      if (count > 0) {
        console.log(`[upgrade-migration] Migrated ${count} emails for inbox ${inbox}`);
        totalMigrated += count;
      }
    } catch (err) {
      console.error(`[upgrade-migration] Failed to migrate inbox ${inbox}:`, err);
      // Continue with remaining inboxes — don't abort the whole migration
    }
  }

  // 2. Refresh plan cache for all inboxes immediately
  try {
    await refreshPlanCache(inboxes, userId);
  } catch (err) {
    console.error('[upgrade-migration] Failed to refresh plan cache:', err);
  }

  console.log(`[upgrade-migration] Done for ${wyiUserId}: ${totalMigrated} total emails migrated across ${inboxes.length} inboxes`);
}