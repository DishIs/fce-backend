// api/src/workers/trial-reminder.ts
//
// Standalone Docker worker.
// Scans all trialing users (app Pro + API plans) and sends reminder emails:
//   · 24 hours before first charge
//   · 3  hours before first charge
//
// Uses per-user boolean flags (trialReminderSent24h, trialReminderSent3h,
// apiTrialReminderSent24h, apiTrialReminderSent3h) to ensure each reminder
// is sent exactly once, even if the worker restarts or runs multiple times.
//
// Run: node dist/trial-reminder.js          (loops forever)
//      node dist/trial-reminder.js --once   (single pass — useful in CI)
//
// Required env vars:
//   MONGO_URI, REDIS_URL, RESEND_API_KEY, APP_URL
//   TRIAL_REMINDER_INTERVAL_MS  (default: 15 minutes)

import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
import { sendEmail } from '../email/resend';
import {
  getTrialEndingEmailHtml,
  getApiTrialEndingEmailHtml,
  TrialReminderData,
  ApiTrialReminderData,
} from '../email/templates';

dotenv.config();

// ── Config ─────────────────────────────────────────────────────────────────────
const MONGO_URI    = process.env.MONGO_URI    || 'mongodb://localhost:27017';
const DB_NAME      = 'freecustomemail';
const INTERVAL_MS  = parseInt(process.env.TRIAL_REMINDER_INTERVAL_MS || '', 10)
  || 15 * 60 * 1000; // 15 minutes — frequent enough to catch the 3h window reliably

// Reminder thresholds in milliseconds
const THRESHOLD_24H = 24 * 60 * 60 * 1000;
const THRESHOLD_3H  =  3 * 60 * 60 * 1000;
// Lower bound: don't re-send if the charge already happened (or is within 30min)
const LOWER_BOUND   = 30 * 60 * 1000;

// ── API plan details for email copy ───────────────────────────────────────────
const API_PLAN_DETAILS: Record<string, { rateLimit: string; monthlyLimit: string }> = {
  developer:  { rateLimit: '10 req/s',  monthlyLimit: '100,000 req/month' },
  startup:    { rateLimit: '25 req/s',  monthlyLimit: '500,000 req/month' },
  growth:     { rateLimit: '50 req/s',  monthlyLimit: '2,000,000 req/month' },
  enterprise: { rateLimit: '100 req/s', monthlyLimit: '10,000,000 req/month' },
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function msUntil(isoDate?: string): number | null {
  if (!isoDate) return null;
  const diff = new Date(isoDate).getTime() - Date.now();
  return diff;
}

function hoursLabel(ms: number): number {
  return Math.ceil(ms / (60 * 60 * 1000));
}

// ═════════════════════════════════════════════════════════════════════════════
//  SWEEP
// ═════════════════════════════════════════════════════════════════════════════

async function runReminderSweep(db: any): Promise<void> {
  const now = new Date();
  console.log('\n' + '─'.repeat(60));
  console.log(`Trial Reminder Sweep — ${now.toISOString()}`);

  const sent = { app24h: 0, app3h: 0, api24h: 0, api3h: 0 };

  // ── App Pro trials ─────────────────────────────────────────────────────────
  // nextBilledAt = when the free trial ends and first payment is taken.
  // We query the range: [now + LOWER_BOUND, now + THRESHOLD_24H + 30min buffer]
  // to catch users whose charge is within the next 24h.
  const appTrialUsers = await db.collection('users').find({
    'subscription.status':      'TRIALING',
    'subscription.nextBilledAt': {
      $gte: new Date(Date.now() + LOWER_BOUND).toISOString(),
      $lte: new Date(Date.now() + THRESHOLD_24H + 30 * 60 * 1000).toISOString(),
    },
    email: { $exists: true, $ne: '' },
    // Only fetch users who still need at least one reminder
    $or: [
      { trialReminderSent24h: { $ne: true } },
      { trialReminderSent3h:  { $ne: true } },
    ],
  }).project({
    wyiUserId: 1, email: 1, plan: 1,
    subscription: 1,
    trialReminderSent24h: 1,
    trialReminderSent3h:  1,
  }).toArray();

  console.log(`  App trialing users in window: ${appTrialUsers.length}`);

  for (const user of appTrialUsers) {
    const chargesAt = user.subscription?.nextBilledAt;
    const msLeft    = msUntil(chargesAt);
    if (msLeft == null) continue;

    const hours = hoursLabel(msLeft);

    // 24h reminder
    if (!user.trialReminderSent24h && msLeft <= THRESHOLD_24H) {
      const data: TrialReminderData = {
        hoursUntilEnd: Math.min(hours, 24),
        chargesAt,
        planName: 'Pro',
      };
      const { error } = await sendEmail({
        to:      user.email,
        from:    'billing',
        subject: `Your FreeCustom.Email Pro trial ends in ${Math.min(hours, 24)} hours`,
        html:    getTrialEndingEmailHtml(data),
      });
      if (!error) {
        await db.collection('users').updateOne(
          { wyiUserId: user.wyiUserId },
          { $set: { trialReminderSent24h: true } },
        );
        sent.app24h++;
        console.log(`  ✉ [app 24h] ${user.email} (~${hours}h left)`);
      } else {
        console.error(`  ✗ [app 24h] ${user.email}:`, error);
      }
    }

    // 3h reminder
    if (!user.trialReminderSent3h && msLeft <= THRESHOLD_3H) {
      const data: TrialReminderData = {
        hoursUntilEnd: Math.min(hours, 3),
        chargesAt,
        planName: 'Pro',
      };
      const { error } = await sendEmail({
        to:      user.email,
        from:    'billing',
        subject: `⏰ Your Pro trial ends in ${Math.min(hours, 3)} hours`,
        html:    getTrialEndingEmailHtml(data),
      });
      if (!error) {
        await db.collection('users').updateOne(
          { wyiUserId: user.wyiUserId },
          { $set: { trialReminderSent3h: true } },
        );
        sent.app3h++;
        console.log(`  ✉ [app  3h] ${user.email} (~${hours}h left)`);
      } else {
        console.error(`  ✗ [app  3h] ${user.email}:`, error);
      }
    }
  }

  // ── API plan trials ────────────────────────────────────────────────────────
  const apiTrialUsers = await db.collection('users').find({
    'apiSubscription.status':      'TRIALING',
    'apiSubscription.nextBilledAt': {
      $gte: new Date(Date.now() + LOWER_BOUND).toISOString(),
      $lte: new Date(Date.now() + THRESHOLD_24H + 30 * 60 * 1000).toISOString(),
    },
    email: { $exists: true, $ne: '' },
    $or: [
      { apiTrialReminderSent24h: { $ne: true } },
      { apiTrialReminderSent3h:  { $ne: true } },
    ],
  }).project({
    wyiUserId: 1, email: 1,
    apiPlan: 1, apiSubscription: 1,
    apiTrialReminderSent24h: 1,
    apiTrialReminderSent3h:  1,
  }).toArray();

  console.log(`  API trialing users in window: ${apiTrialUsers.length}`);

  for (const user of apiTrialUsers) {
    const chargesAt = user.apiSubscription?.nextBilledAt;
    const msLeft    = msUntil(chargesAt);
    if (msLeft == null) continue;

    const apiPlan    = (user.apiPlan || 'developer') as string;
    const planLabel  = apiPlan.charAt(0).toUpperCase() + apiPlan.slice(1);
    const planDets   = API_PLAN_DETAILS[apiPlan] ?? { rateLimit: 'varies', monthlyLimit: 'varies' };
    const hours      = hoursLabel(msLeft);

    // 24h reminder
    if (!user.apiTrialReminderSent24h && msLeft <= THRESHOLD_24H) {
      const data: ApiTrialReminderData = {
        hoursUntilEnd: Math.min(hours, 24),
        chargesAt,
        planName:     planLabel,
        apiPlan,
        rateLimit:    planDets.rateLimit,
        monthlyLimit: planDets.monthlyLimit,
      };
      const { error } = await sendEmail({
        to:      user.email,
        from:    'api',
        subject: `Your FreeCustom.Email API ${planLabel} trial ends in ${Math.min(hours, 24)} hours`,
        html:    getApiTrialEndingEmailHtml(data),
      });
      if (!error) {
        await db.collection('users').updateOne(
          { wyiUserId: user.wyiUserId },
          { $set: { apiTrialReminderSent24h: true } },
        );
        sent.api24h++;
        console.log(`  ✉ [api 24h] ${user.email} (${planLabel}, ~${hours}h left)`);
      } else {
        console.error(`  ✗ [api 24h] ${user.email}:`, error);
      }
    }

    // 3h reminder
    if (!user.apiTrialReminderSent3h && msLeft <= THRESHOLD_3H) {
      const data: ApiTrialReminderData = {
        hoursUntilEnd: Math.min(hours, 3),
        chargesAt,
        planName:     planLabel,
        apiPlan,
        rateLimit:    planDets.rateLimit,
        monthlyLimit: planDets.monthlyLimit,
      };
      const { error } = await sendEmail({
        to:      user.email,
        from:    'api',
        subject: `⏰ API ${planLabel} trial ends in ${Math.min(hours, 3)} hours`,
        html:    getApiTrialEndingEmailHtml(data),
      });
      if (!error) {
        await db.collection('users').updateOne(
          { wyiUserId: user.wyiUserId },
          { $set: { apiTrialReminderSent3h: true } },
        );
        sent.api3h++;
        console.log(`  ✉ [api  3h] ${user.email} (${planLabel}, ~${hours}h left)`);
      } else {
        console.error(`  ✗ [api  3h] ${user.email}:`, error);
      }
    }
  }

  console.log(
    `  Sent — App: 24h=${sent.app24h} 3h=${sent.app3h} | API: 24h=${sent.api24h} 3h=${sent.api3h}`,
  );
  console.log('─'.repeat(60) + '\n');
}

// ═════════════════════════════════════════════════════════════════════════════
//  ENTRY POINT
// ═════════════════════════════════════════════════════════════════════════════

async function main() {
  const once = process.argv.includes('--once');

  const mongoClient = new MongoClient(MONGO_URI);
  await mongoClient.connect();
  const db = mongoClient.db(DB_NAME);

  console.log(`Trial reminder worker connected. Interval: ${INTERVAL_MS / 60000} min.`);

  try {
    if (once) {
      await runReminderSweep(db);
    } else {
      while (true) {
        await runReminderSweep(db);
        console.log(`Sleeping ${INTERVAL_MS / 1000 / 60} min until next sweep…`);
        await new Promise(r => setTimeout(r, INTERVAL_MS));
      }
    }
  } finally {
    await mongoClient.close();
  }
}

main().catch(err => {
  console.error('Trial reminder worker FAILED:', err);
  process.exit(1);
});