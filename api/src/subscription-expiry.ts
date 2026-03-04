// api/src/subscription-expiry.ts
//
// Runs as a standalone Docker worker.
// Handles TWO kinds of scheduled downgrades:
//
//   1. App Pro plan  — scheduledDowngradeAt  (existing logic, unchanged)
//   2. API plan      — apiScheduledDowngradeAt (new — mirrors the same pattern)
//
// Run: node dist/subscription-expiry.js          (loops forever)
//      node dist/subscription-expiry.js --once   (single pass, useful for testing)

import { MongoClient, ObjectId } from 'mongodb';
import { createClient } from 'redis';
import dotenv from 'dotenv';
import { sendEmail, FROM } from './email/resend';
import {
  getDowngradeCompleteEmailHtml,
  getApiPlanDowngradeEmailHtml,
} from './email/templates';

dotenv.config();

// ── Config ────────────────────────────────────────────────────────────────────
const MONGO_URI        = process.env.MONGO_URI        || 'mongodb://localhost:27017';
const REDIS_URL        = process.env.REDIS_URL        || 'redis://localhost:6379';
const DB_NAME          = 'freecustomemail';
const INTERVAL_MS      = parseInt(process.env.EXPIRY_INTERVAL_MS    || '', 10) || 6 * 60 * 60 * 1000;
const FREE_MAILBOX_SIZE = parseInt(process.env.FREE_MAILBOX_SIZE     || '20',   10);
const FREE_MAILBOX_TTL  = parseInt(process.env.FREE_MAILBOX_TTL      || '86400',10);
const PLAN_CACHE_TTL    = parseInt(process.env.PLAN_CACHE_TTL        || '3600', 10);

// ── Types ─────────────────────────────────────────────────────────────────────
interface UserToProcess {
  _id:                      ObjectId;
  wyiUserId:                string;
  email:                    string;
  inboxes:                  string[];
  apiInboxes:               string[];
  plan:                     string;
  apiPlan:                  string;
  scheduledDowngradeAt?:    Date;
  apiScheduledDowngradeAt?: Date;
}

// ═════════════════════════════════════════════════════════════════════════════
//  SHARED REDIS HELPERS
// ═════════════════════════════════════════════════════════════════════════════

async function demoteInboxToFree(
  redis: ReturnType<typeof createClient>,
  mailbox: string,
): Promise<void> {
  const proIndex  = `maildrop:pro:${mailbox}:index`;
  const proData   = `maildrop:pro:${mailbox}:data`;
  const freeIndex = `maildrop:free:${mailbox}:index`;
  const freeData  = `maildrop:free:${mailbox}:data`;

  const entries = await redis.zRangeWithScores(proIndex, 0, -1, { REV: true });
  if (!entries || entries.length === 0) {
    await redis.del([proIndex, proData]);
    return;
  }

  const keep  = entries.slice(0, FREE_MAILBOX_SIZE);
  const ids   = keep.map(e => e.value);
  const raws  = await redis.hmGet(proData, ids);
  const multi = redis.multi();

  for (let i = 0; i < keep.length; i++) {
    const raw = raws[i];
    if (!raw) continue;
    multi.zAdd(freeIndex, { score: keep[i].score, value: keep[i].value });
    multi.hSet(freeData, keep[i].value, raw);
  }

  multi.expire(freeIndex, FREE_MAILBOX_TTL);
  multi.expire(freeData,  FREE_MAILBOX_TTL);
  multi.del(proIndex);
  multi.del(proData);
  await multi.exec();

  const dropped = entries.length - keep.length;
  if (dropped > 0) {
    console.log(`  [redis] ${mailbox}: kept newest ${keep.length}, dropped ${dropped}`);
  }
}

async function refreshPlanCacheForInboxes(
  redis: ReturnType<typeof createClient>,
  userId: ObjectId,
  inboxes: string[],
  plan: 'free' | 'anonymous',
): Promise<void> {
  if (!inboxes.length) return;
  const userData = JSON.stringify({ plan, userId: userId.toString(), isVerified: false });
  const multi    = redis.multi();
  for (const inbox of inboxes) {
    multi.set(`user_data_cache:${inbox}`, userData, { EX: PLAN_CACHE_TTL });
  }
  await multi.exec();
}

// ═════════════════════════════════════════════════════════════════════════════
//  APP PRO PLAN DOWNGRADE  (existing logic, nodemailer → Resend)
// ═════════════════════════════════════════════════════════════════════════════

async function downgradeAppPlan(
  db:    any,
  redis: ReturnType<typeof createClient>,
  user:  UserToProcess,
): Promise<void> {
  console.log(`  [app] Downgrading ${user.wyiUserId} (${user.email}) from Pro → free`);

  for (const inbox of user.inboxes) {
    try {
      await demoteInboxToFree(redis, inbox);
    } catch (err) {
      console.error(`  [redis] Failed to demote inbox ${inbox}:`, err);
    }
  }

  await refreshPlanCacheForInboxes(redis, user._id, user.inboxes, 'free');

  await db.collection('users').updateOne(
    { _id: user._id },
    {
      $set: {
        plan:                             'free',
        'subscription.status':            'CANCELLED',
        'subscription.cancelAtPeriodEnd': false,
        'subscription.lastUpdated':       new Date(),
      },
      $unset: {
        scheduledDowngradeAt:       '',
        'subscription.periodEnd':   '',
      },
    },
  );

  if (user.email) {
    sendEmail({
      to:      user.email,
      from:    'billing',
      subject: 'Your FreeCustom.Email account has been downgraded to free',
      html:    getDowngradeCompleteEmailHtml(),
    }).catch(err => console.error(`  [resend] Downgrade email failed for ${user.email}:`, err));
  }

  console.log(`  ✅ [app] ${user.wyiUserId} downgraded to free.`);
}

// ═════════════════════════════════════════════════════════════════════════════
//  API PLAN DOWNGRADE  (new)
// ═════════════════════════════════════════════════════════════════════════════

async function downgradeApiPlan(
  db:    any,
  redis: ReturnType<typeof createClient>,
  user:  UserToProcess,
): Promise<void> {
  const previousPlan = user.apiPlan;
  console.log(`  [api] Downgrading ${user.wyiUserId} API plan: ${previousPlan} → free`);

  // ── 1. Refresh Haraka plan cache for API inboxes ────────────────────────
  // API inboxes on growth/enterprise were cached as 'pro'.
  // After downgrade they're 'anonymous' (no persistent storage).
  await refreshPlanCacheForInboxes(redis, user._id, user.apiInboxes, 'anonymous');

  // ── 2. Update MongoDB ───────────────────────────────────────────────────
  await db.collection('users').updateOne(
    { _id: user._id },
    {
      $set: {
        apiPlan:                                  'free',
        'apiSubscription.status':                 'CANCELLED',
        'apiSubscription.cancelAtPeriodEnd':      false,
        'apiSubscription.lastUpdated':            new Date(),
      },
      $unset: {
        apiScheduledDowngradeAt:                  '',
        'apiSubscription.periodEnd':              '',
      },
    },
  );

  // ── 3. Notify user ──────────────────────────────────────────────────────
  if (user.email) {
    sendEmail({
      to:      user.email,
      from:    'api',
      subject: `Your FreeCustom.Email API ${previousPlan} plan has ended`,
      html:    getApiPlanDowngradeEmailHtml(previousPlan),
    }).catch(err => console.error(`  [resend] API downgrade email failed for ${user.email}:`, err));
  }

  console.log(`  ✅ [api] ${user.wyiUserId} API plan downgraded to free.`);
}

// ═════════════════════════════════════════════════════════════════════════════
//  SWEEP
// ═════════════════════════════════════════════════════════════════════════════

async function runExpirySweep(
  db:    any,
  redis: ReturnType<typeof createClient>,
): Promise<void> {
  const now = new Date();
  console.log('\n' + '='.repeat(60));
  console.log(`Subscription Expiry Sweep — ${now.toISOString()}`);
  console.log('='.repeat(60));

  // Find users with EITHER type of pending downgrade
  const users: UserToProcess[] = await db.collection('users').find({
    $or: [
      { plan: 'pro',                        scheduledDowngradeAt:    { $lte: now } },
      { apiPlan: { $ne: 'free', $exists: true }, apiScheduledDowngradeAt: { $lte: now } },
    ],
  }).project({
    _id:                      1,
    wyiUserId:                1,
    email:                    1,
    inboxes:                  1,
    apiInboxes:               1,
    plan:                     1,
    apiPlan:                  1,
    scheduledDowngradeAt:     1,
    apiScheduledDowngradeAt:  1,
  }).toArray();

  console.log(`Found ${users.length} user(s) with pending downgrade(s).\n`);

  let appSucceeded = 0, appFailed = 0;
  let apiSucceeded = 0, apiFailed = 0;

  for (const user of users) {
    // ── App Pro downgrade ─────────────────────────────────────────────────
    if (user.plan === 'pro' && user.scheduledDowngradeAt && user.scheduledDowngradeAt <= now) {
      try {
        await downgradeAppPlan(db, redis, user);
        appSucceeded++;
      } catch (err) {
        console.error(`  ❌ [app] Failed to downgrade ${user.wyiUserId}:`, err);
        appFailed++;
      }
    }

    // ── API plan downgrade ────────────────────────────────────────────────
    if (
      user.apiPlan &&
      user.apiPlan !== 'free' &&
      user.apiScheduledDowngradeAt &&
      user.apiScheduledDowngradeAt <= now
    ) {
      try {
        await downgradeApiPlan(db, redis, user);
        apiSucceeded++;
      } catch (err) {
        console.error(`  ❌ [api] Failed to downgrade API plan for ${user.wyiUserId}:`, err);
        apiFailed++;
      }
    }
  }

  console.log('\n' + '-'.repeat(60));
  console.log(`App plan  — ✅ downgraded: ${appSucceeded}  ❌ failed: ${appFailed}`);
  console.log(`API plan  — ✅ downgraded: ${apiSucceeded}  ❌ failed: ${apiFailed}`);
  console.log('='.repeat(60) + '\n');
}

// ═════════════════════════════════════════════════════════════════════════════
//  ENTRY POINT
// ═════════════════════════════════════════════════════════════════════════════

async function main() {
  const once = process.argv.includes('--once');

  const mongoClient = new MongoClient(MONGO_URI);
  const redis       = createClient({ url: REDIS_URL });
  redis.on('error', err => console.error('Redis error:', err));

  await mongoClient.connect();
  await redis.connect();

  const db = mongoClient.db(DB_NAME);
  console.log('Subscription expiry worker connected.');

  try {
    if (once) {
      await runExpirySweep(db, redis);
    } else {
      while (true) {
        await runExpirySweep(db, redis);
        console.log(`Sleeping ${INTERVAL_MS / 1000 / 60} min until next sweep...`);
        await new Promise(r => setTimeout(r, INTERVAL_MS));
      }
    }
  } finally {
    await mongoClient.close();
    await redis.quit();
  }
}

main().catch(err => {
  console.error('Subscription expiry worker FAILED:', err);
  process.exit(1);
});