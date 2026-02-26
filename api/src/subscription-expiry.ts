// api/src/subscription-expiry.ts
//
// Runs as a standalone Docker worker.
// Finds users where scheduledDowngradeAt <= now and downgrades them to free.
//
// scheduledDowngradeAt is always set to the Paddle billing period end, so:
//   • Trial cancel on Day 2 of 3 → downgrade on Day 3 (trial end)
//   • Cancel after being charged → downgrade on next billing date
//   • No fixed +N day offsets anywhere
//
// What downgrade does:
//   1. Sets subscription.status = 'CANCELLED', plan = 'free'
//   2. Moves pro Redis keys → free Redis keys with TTL + size cap
//   3. Refreshes user_data_cache so SMTP plugin sees 'free' immediately
//   4. Does NOT delete MongoDB saved_emails (user keeps read-only history)
//
// Run: node dist/subscription-expiry.js          (loops forever)
//      node dist/subscription-expiry.js --once   (single pass)

import { MongoClient, ObjectId } from 'mongodb';
import { createClient } from 'redis';
import dotenv from 'dotenv';
import nodemailer from 'nodemailer';
import { getDowngradeCompleteEmailHtml } from './email/templates';


dotenv.config();

// ── Config ────────────────────────────────────────────────────────────────────

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const DB_NAME = 'freecustomemail';
const INTERVAL_MS = parseInt(process.env.EXPIRY_INTERVAL_MS || '', 10) || 6 * 60 * 60 * 1000;
const FREE_MAILBOX_SIZE = parseInt(process.env.FREE_MAILBOX_SIZE || '20', 10);
const FREE_MAILBOX_TTL = parseInt(process.env.FREE_MAILBOX_TTL || '86400', 10);
const PLAN_CACHE_TTL = parseInt(process.env.PLAN_CACHE_TTL || '3600', 10);

// ── Types ─────────────────────────────────────────────────────────────────────

interface UserToDowngrade {
    _id: ObjectId;
    wyiUserId: string;
    email: string;
    inboxes: string[];
    scheduledDowngradeAt: Date;
}

const mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.zoho.in',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_PORT === '465',
    auth: { user: process.env.SMTP_USER || '', pass: process.env.SMTP_PASS || '' },
});


// ── Redis helpers ─────────────────────────────────────────────────────────────

async function demoteInboxToFree(
    redis: ReturnType<typeof createClient>,
    mailbox: string,
): Promise<void> {
    const proIndex = `maildrop:pro:${mailbox}:index`;
    const proData = `maildrop:pro:${mailbox}:data`;
    const freeIndex = `maildrop:free:${mailbox}:index`;
    const freeData = `maildrop:free:${mailbox}:data`;

    // Read all pro messages newest-first
    const entries = await redis.zRangeWithScores(proIndex, 0, -1, { REV: true });
    if (!entries || entries.length === 0) {
        await redis.del([proIndex, proData]);
        return;
    }

    // Cap to free mailbox size — keep newest FREE_MAILBOX_SIZE messages
    const keep = entries.slice(0, FREE_MAILBOX_SIZE);
    const ids = keep.map(e => e.value);
    const raws = await redis.hmGet(proData, ids);

    const multi = redis.multi();

    for (let i = 0; i < keep.length; i++) {
        const raw = raws[i];
        if (!raw) continue;
        multi.zAdd(freeIndex, { score: keep[i].score, value: keep[i].value });
        multi.hSet(freeData, keep[i].value, raw);
    }

    // Apply free TTL
    multi.expire(freeIndex, FREE_MAILBOX_TTL);
    multi.expire(freeData, FREE_MAILBOX_TTL);

    // Delete pro keys
    multi.del(proIndex);
    multi.del(proData);

    await multi.exec();

    const dropped = entries.length - keep.length;
    if (dropped > 0) {
        console.log(`  [redis] ${mailbox}: kept newest ${keep.length}, dropped ${dropped} older emails`);
    }
}

async function refreshPlanCacheFree(
    redis: ReturnType<typeof createClient>,
    userId: ObjectId,
    inboxes: string[],
): Promise<void> {
    const userData = JSON.stringify({
        plan: 'free',
        userId: userId.toString(),
        isVerified: false,
    });

    const multi = redis.multi();
    for (const inbox of inboxes) {
        multi.set(`user_data_cache:${inbox}`, userData, { EX: PLAN_CACHE_TTL });
    }
    await multi.exec();
}

// ── Downgrade a single user ───────────────────────────────────────────────────

async function downgradeUser(
    db: any,
    redis: ReturnType<typeof createClient>,
    user: UserToDowngrade,
): Promise<void> {
    console.log(`  Downgrading ${user.wyiUserId} (${user.email})`);

    // 1. Demote Redis keys
    for (const inbox of user.inboxes) {
        try {
            await demoteInboxToFree(redis, inbox);
        } catch (err) {
            console.error(`  [redis] Failed to demote inbox ${inbox}:`, err);
        }
    }

    // 2. Refresh SMTP plugin's plan cache
    try {
        await refreshPlanCacheFree(redis, user._id, user.inboxes);
    } catch (err) {
        console.error(`  [redis] Failed to refresh plan cache:`, err);
    }

    // 3. Finalise in MongoDB:
    //    - plan → 'free'
    //    - subscription.status → 'CANCELLED' (now it's actually over)
    //    - clear cancelAtPeriodEnd flag and scheduledDowngradeAt
    await db.collection('users').updateOne(
        { _id: user._id },
        {
            $set: {
                plan: 'free',
                'subscription.status': 'CANCELLED',
                'subscription.cancelAtPeriodEnd': false,
                'subscription.lastUpdated': new Date(),
            },
            $unset: {
                scheduledDowngradeAt: '',
                'subscription.periodEnd': '',  // no longer needed
            },
        }
    );

    if (user.email && process.env.SMTP_USER) {
        mailer.sendMail({
            from: process.env.MAIL_FROM || '"FreeCustom.Email" <no-reply@freecustom.email>',
            to: user.email,
            subject: 'Your FreeCustom.Email account has been downgraded to free',
            html: getDowngradeCompleteEmailHtml(),
        }).catch(err => console.error(`  [mailer] Failed to send downgrade email to ${user.email}:`, err));
    }

    console.log(`  ✅ ${user.wyiUserId} downgraded to free.`);
}

// ── Sweep ─────────────────────────────────────────────────────────────────────

async function runExpirySweep(
    db: any,
    redis: ReturnType<typeof createClient>,
): Promise<void> {
    const now = new Date();
    console.log('\n' + '='.repeat(60));
    console.log(`Subscription Expiry Sweep — ${now.toISOString()}`);
    console.log('='.repeat(60));

    const users: UserToDowngrade[] = await db.collection('users').find({
        plan: 'pro',
        scheduledDowngradeAt: { $lte: now },
    }).project({
        _id: 1,
        wyiUserId: 1,
        email: 1,
        inboxes: 1,
        scheduledDowngradeAt: 1,
    }).toArray();

    console.log(`Found ${users.length} user(s) to downgrade.\n`);

    let succeeded = 0;
    let failed = 0;

    for (const user of users) {
        try {
            await downgradeUser(db, redis, user);
            succeeded++;
        } catch (err) {
            console.error(`  ❌ Failed to downgrade ${user.wyiUserId}:`, err);
            failed++;
        }
    }

    console.log('\n' + '-'.repeat(60));
    console.log(`Results — ✅ downgraded: ${succeeded}  ❌ failed: ${failed}`);
    console.log('='.repeat(60) + '\n');
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
    const once = process.argv.includes('--once');

    const mongoClient = new MongoClient(MONGO_URI);
    const redis = createClient({ url: REDIS_URL });
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