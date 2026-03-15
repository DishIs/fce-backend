// api/src/workers/deletion-worker.ts
//
// Runs as a standalone Docker worker. After the 7-day cooldown, permanently
// deletes user accounts: tombstone user doc, add email (7–14 days) and IP (24h)
// cooldown, send confirmation email. Keeps payment_logs and account id for billing.
//
// Run: node dist/deletion-worker.js
//      node dist/deletion-worker.js --once

import { MongoClient, ObjectId } from 'mongodb';
import dotenv from 'dotenv';
import { sendEmail } from '../email/resend';
import { getDeletionPermanentEmailHtml } from '../email/templates';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017';
const DB_NAME = 'freecustomemail';
const INTERVAL_MS = parseInt(process.env.DELETION_WORKER_INTERVAL_MS || '', 10) || 60 * 60 * 1000; // 1h
const EMAIL_COOLDOWN_DAYS_MIN = 7;
const EMAIL_COOLDOWN_DAYS_MAX = 14;
const IP_COOLDOWN_HOURS = 24;

async function addDeletionCooldown(db: any, type: 'email' | 'ip', value: string, blockedUntil: Date): Promise<void> {
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return;
  await db.collection('deletion_cooldowns').updateOne(
    { type, value: normalized },
    { $set: { type, value: normalized, blockedUntil, createdAt: new Date() } },
    { upsert: true }
  );
}

async function runOnce(db: any): Promise<number> {
  const now = new Date();
  const cursor = db.collection('users').find({
    deletionStatus: 'scheduled',
    scheduledDeletionAt: { $lte: now },
  }, { projection: { _id: 1, wyiUserId: 1, email: 1, ipAtDeletionRequest: 1, name: 1 } });

  let processed = 0;
  for await (const user of cursor) {
    const email = user.email;
    const ip = user.ipAtDeletionRequest;

    // Tombstone: keep _id and wyiUserId for payment_logs / references, clear PII
    await db.collection('users').updateOne(
      { _id: user._id },
      {
        $set: {
          deletionStatus: 'permanent',
          email: '',
          name: 'Deleted User',
          plan: 'free',
          lastLoginAt: null,
          settings: {},
          inboxes: [],
          apiInboxes: [],
          inboxHistory: [],
          customDomains: [],
          mutedSenders: [],
          linkedProviderIds: [],
          subscription: null,
          apiPlan: 'free',
          apiCredits: 0,
          apiSubscription: null,
          fcmToken: null,
          ipAtDeletionRequest: null,
        },
        $unset: {
          deletionRequestedAt: '',
          scheduledDeletionAt: '',
        },
      }
    );

    const emailCooldownDays = EMAIL_COOLDOWN_DAYS_MIN + Math.floor(Math.random() * (EMAIL_COOLDOWN_DAYS_MAX - EMAIL_COOLDOWN_DAYS_MIN + 1));
    const emailBlockedUntil = new Date(now.getTime() + emailCooldownDays * 24 * 60 * 60 * 1000);
    const ipBlockedUntil = new Date(now.getTime() + IP_COOLDOWN_HOURS * 60 * 60 * 1000);

    if (email) await addDeletionCooldown(db, 'email', email, emailBlockedUntil);
    if (ip) await addDeletionCooldown(db, 'ip', ip, ipBlockedUntil);

    if (email) {
      const html = getDeletionPermanentEmailHtml();
      await sendEmail({
        to: email,
        subject: 'Your FreeCustom.Email account has been permanently deleted',
        html,
        from: 'noreply',
      }).catch((err) => console.error('[deletion-worker] Email failed for', email, err));
    }

    processed++;
    console.log('[deletion-worker] Permanently deleted account', user.wyiUserId, 'email cooldown until', emailBlockedUntil.toISOString());
  }

  return processed;
}

async function main() {
  const once = process.argv.includes('--once');
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(DB_NAME);

  console.log('[deletion-worker] Started. Interval:', once ? 'single run' : `${INTERVAL_MS / 1000}s`);

  const loop = async () => {
    try {
      const count = await runOnce(db);
      if (count > 0) console.log('[deletion-worker] Processed', count, 'account(s).');
    } catch (err) {
      console.error('[deletion-worker] Error:', err);
    }
    if (once) {
      await client.close();
      process.exit(0);
    }
    setTimeout(loop, INTERVAL_MS);
  };
  await loop();
  if (!once) await new Promise<void>(() => {}); // never resolve — keep process alive

}

main();
