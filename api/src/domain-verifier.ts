// api/src/domain-verifier.ts
//
// Runs as a standalone worker (separate Docker service).
// Periodically re-validates DNS records (TXT + MX) for every verified
// custom domain. If either check fails the domain is de-verified in
// MongoDB and evicted from the Redis set that the SMTP rcpt hook uses.
//
// Run manually:  npx ts-node src/domain-verifier.ts [--once]
// In Docker:     node dist/domain-verifier.js          (loops forever)
//   --once       Run a single pass then exit (useful for cron / testing)

import { MongoClient, ObjectId } from 'mongodb';
import { createClient }          from 'redis';
import * as dns                  from 'dns/promises';
import nodemailer                from 'nodemailer';
import type { Transporter }      from 'nodemailer';
import dotenv from 'dotenv';
import { getDomainRevocationEmailHtml, getDomainWarningEmailHtml } from './email/templates';
dotenv.config();

// ── Config ───────────────────────────────────────────────────────────────────

const MONGO_URI  = process.env.MONGO_URI  || 'mongodb://localhost:27017';
const REDIS_URL  = process.env.REDIS_URL  || 'redis://localhost:6379';
const DB_NAME    = 'freecustomemail';

// How long to sleep between full verification sweeps (default 6 h)
const INTERVAL_MS = parseInt(process.env.VERIFY_INTERVAL_MS || '', 10) || 6 * 60 * 60 * 1000;

// How many consecutive DNS failures before we revoke (guards against transient flaps)
const FAILURE_THRESHOLD = parseInt(process.env.FAILURE_THRESHOLD || '', 10) || 2;

// Our authoritative MX suffix — any MX ending with this is accepted
const OUR_MX_SUFFIX = (process.env.OUR_MX_SUFFIX || 'mx.freecustom.email').toLowerCase();

// Redis key — must match what rcpt_to_mongo.js uses
const VERIFIED_DOMAINS_KEY = 'verified_custom_domains';

// ── Mailer config ────────────────────────────────────────────────────────────
// Uses SMTP env vars. Works with SES, Postmark, Mailgun, Resend, or plain Gmail.
const SMTP_HOST     = process.env.SMTP_HOST || 'smtp.zoho.in';
const SMTP_PORT     = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER     = process.env.SMTP_USER || '';
const SMTP_PASS     = process.env.SMTP_PASS || '';
const MAIL_FROM     = process.env.MAIL_FROM || '"FreeCustom.Email" <no-reply@freecustom.email>';
const APP_URL       = process.env.APP_URL   || 'https://www.freecustom.email';
// Set MAIL_DISABLED=true in staging to skip actual sends
const MAIL_DISABLED = process.env.MAIL_DISABLED === 'true';

// ── Types ──────────────────────────────────────────────────────────────────── ────────────────────────────────────────────────────────────────────

interface DomainRecord {
    domain:    string;
    verified:  boolean;
    txtRecord: string;
    mxRecord?: string;
    // We persist consecutive failure count so transient DNS blips don't revoke
    dnsFailures?: number;
}

interface ProUser {
    _id:           ObjectId;
    email:         string;
    customDomains: DomainRecord[];
}

interface VerifyResult {
    domain:            string;
    txtOk:             boolean;
    mxOk:              boolean;
    revoked:           boolean;
    warningSent:       boolean;
    error?:            string;
}

// ── Mailer ───────────────────────────────────────────────────────────────────

let transporter: Transporter | null = null;

function getTransporter(): Transporter {
    if (!transporter) {
        transporter = nodemailer.createTransport({
            host:   SMTP_HOST,
            port:   SMTP_PORT,
            secure: SMTP_PORT === 465,
            auth:   { user: SMTP_USER, pass: SMTP_PASS },
        });
    }
    return transporter;
}

async function sendWarningEmail(toEmail: string, domain: string, txtOk: boolean, mxOk: boolean) {
  if (MAIL_DISABLED || !SMTP_USER) {
    console.log(`  [mailer] Skipped warning email to ${toEmail} (disabled or unconfigured)`);
    return;
  }
  await getTransporter().sendMail({
    from:    MAIL_FROM,
    to:      toEmail,
    subject: `⚠️ Action required: DNS issue detected for ${domain}`,
    html:    getDomainWarningEmailHtml(domain, txtOk, mxOk),
  });
  console.log(`  [mailer] Warning email sent to ${toEmail} for ${domain}`);
}

async function sendRevocationEmail(toEmail: string, domain: string, txtOk: boolean, mxOk: boolean) {
  if (MAIL_DISABLED || !SMTP_USER) {
    console.log(`  [mailer] Skipped revocation email to ${toEmail} (disabled or unconfigured)`);
    return;
  }
  await getTransporter().sendMail({
    from:    MAIL_FROM,
    to:      toEmail,
    subject: `❌ Custom domain ${domain} has been de-verified`,
    html:    getDomainRevocationEmailHtml(domain, txtOk, mxOk),
  });
  console.log(`  [mailer] Revocation email sent to ${toEmail} for ${domain}`);
}


// ── DNS helpers ───────────────────────────────────────────────────────────────

async function checkTxt(domain: string, expected: string): Promise<boolean> {
    const records = await dns.resolveTxt(domain);
    // Each TXT record can be split across multiple chunks — join them.
    // Trim both sides to guard against whitespace differences in stored value.
    const expectedNorm = expected.trim();
    return records
        .map(chunks => chunks.join('').trim())
        .some(val => val === expectedNorm);
}

async function checkMx(domain: string): Promise<boolean> {
    const records = await dns.resolveMx(domain);
    return records.some(mx => {
        // dns.resolveMx often returns a trailing dot — strip it before comparing
        const exchange = mx.exchange.toLowerCase().replace(/\.$/, '');
        // Accept exact match OR subdomain of our suffix
        // e.g. "mx.freecustom.email" or "mx2.freecustom.email" both pass
        return exchange === OUR_MX_SUFFIX || exchange.endsWith(`.${OUR_MX_SUFFIX.split('.').slice(1).join('.')}`);
    });
}

// ── Per-domain verification ──────────────────────────────────────────────────

async function verifyDomain(
    db:      any,
    redis:   ReturnType<typeof createClient>,
    user:    ProUser,
    rec:     DomainRecord,
    dryRun:  boolean,
): Promise<VerifyResult> {

    const { domain, txtRecord } = rec;
    let txtOk   = false;
    let mxOk    = false;
    let dnsErr: string | undefined;

    try {
        [txtOk, mxOk] = await Promise.all([
            checkTxt(domain, txtRecord).catch(() => false),
            checkMx(domain).catch((err) => {
                // ENODATA / ENOTFOUND = no MX records at all → treat as failure
                if (err.code === 'ENODATA' || err.code === 'ENOTFOUND') return false;
                throw err; // unexpected error — re-throw so outer catch handles it
            }),
        ]);
    } catch (err: any) {
        dnsErr = err.message;
        // Network / resolver error — don't revoke yet, just count the failure
        console.warn(`  [${domain}] DNS error: ${dnsErr}`);
    }

    const passed       = txtOk && mxOk && !dnsErr;
    const currentFails = rec.dnsFailures ?? 0;
    const newFails     = passed ? 0 : currentFails + 1;
    const shouldRevoke = !passed && newFails >= FAILURE_THRESHOLD;

    const result: VerifyResult = { domain, txtOk, mxOk, revoked: false, warningSent: false, error: dnsErr };

    if (dryRun) {
        if (shouldRevoke) {
            console.log(`  [DRY RUN] Would revoke ${domain} (failures: ${newFails}/${FAILURE_THRESHOLD})`);
            result.revoked = true;
        } else if (!passed) {
            console.log(`  [${domain}] Failure ${newFails}/${FAILURE_THRESHOLD} — not revoking yet`);
        }
        return result;
    }

    if (passed) {
        // Reset failure counter + ensure domain is in the Redis set
        if (currentFails > 0) {
            await db.collection('users').updateOne(
                { _id: user._id, 'customDomains.domain': domain },
                { $set: { 'customDomains.$.dnsFailures': 0 } }
            );
        }
        // Warm Redis cache (idempotent)
        await redis.sAdd(VERIFIED_DOMAINS_KEY, domain);
        return result;
    }

    // ── Failing ──────────────────────────────────────────────────────────────

    // Increment failure counter
    await db.collection('users').updateOne(
        { _id: user._id, 'customDomains.domain': domain },
        { $set: { 'customDomains.$.dnsFailures': newFails } }
    );

    if (shouldRevoke) {
        // Revoke in Mongo + Redis
        await db.collection('users').updateOne(
            { _id: user._id, 'customDomains.domain': domain },
            { $set: { 'customDomains.$.verified': false, 'customDomains.$.dnsFailures': 0 } }
        );
        await redis.sRem(VERIFIED_DOMAINS_KEY, domain);
        result.revoked = true;
        console.log(`  [${domain}] REVOKED after ${newFails} consecutive failures (TXT:${txtOk} MX:${mxOk})`);

        // Fire revocation email — don't let a send failure crash the sweep
        sendRevocationEmail(user.email, domain, txtOk, mxOk).catch(err =>
            console.error(`  [mailer] Failed to send revocation email for ${domain}: ${err.message}`)
        );

    } else {
        console.log(`  [${domain}] Failure ${newFails}/${FAILURE_THRESHOLD} — will revoke next pass if it persists`);

        // Send a warning email only on the FIRST failure (currentFails === 0)
        // so we don't spam them once per sweep.
        if (currentFails === 0) {
            result.warningSent = true;
            sendWarningEmail(user.email, domain, txtOk, mxOk).catch(err =>
                console.error(`  [mailer] Failed to send warning email for ${domain}: ${err.message}`)
            );
        }
    }

    return result;
}

// ── Full sweep ───────────────────────────────────────────────────────────────

async function runVerification(
    db:     any,
    redis:  ReturnType<typeof createClient>,
    dryRun: boolean,
): Promise<void> {
    const now = new Date();
    console.log('\n' + '='.repeat(60));
    console.log(`Domain Verification Sweep — ${now.toISOString()}`);
    console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
    console.log('='.repeat(60));

    const users: ProUser[] = await db.collection('users')
        .find({ plan: 'pro', 'customDomains.verified': true })
        .project({ _id: 1, email: 1, customDomains: 1 })
        .toArray();

    const verifiedDomains = users.flatMap(u =>
        (u.customDomains || []).filter(d => d.verified)
    );

    console.log(`\nFound ${verifiedDomains.length} verified domain(s) across ${users.length} pro user(s)\n`);

    let passed   = 0;
    let revoked  = 0;
    let pending  = 0; // failing but under threshold
    let warnings = 0;

    for (const user of users) {
        const domains = (user.customDomains || []).filter(d => d.verified);
        if (domains.length === 0) continue;

        console.log(`User: ${user.email}`);

        for (const rec of domains) {
            const result = await verifyDomain(db, redis, user, rec, dryRun);

            if (result.revoked)                      revoked++;
            else if (!result.txtOk || !result.mxOk) pending++;
            else                                     passed++;

            if (result.warningSent) warnings++;
        }
    }

    // ── Sync Redis: remove any stale domains no longer in Mongo ──────────────
    // This catches domains deleted via the dashboard that may still be in Redis.
    if (!dryRun) {
        const allVerifiedInMongo = new Set(verifiedDomains.map(d => d.domain));
        const allInRedis         = await redis.sMembers(VERIFIED_DOMAINS_KEY);
        const stale              = allInRedis.filter(d => !allVerifiedInMongo.has(d));

        if (stale.length > 0) {
            await redis.sRem(VERIFIED_DOMAINS_KEY, stale);
            console.log(`\nEvicted ${stale.length} stale Redis cache entr(ies): ${stale.join(', ')}`);
        }
    }

    console.log('\n' + '-'.repeat(60));
    console.log(`Results — ✅ passed: ${passed}  ⏳ pending-revoke: ${pending}  ❌ revoked: ${revoked}  📧 warnings sent: ${warnings}`);
    console.log('='.repeat(60) + '\n');
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function main() {
    const args   = process.argv.slice(2);
    const once   = args.includes('--once');
    const dryRun = args.includes('--dry-run');

    const mongoClient = new MongoClient(MONGO_URI);
    const redis       = createClient({ url: REDIS_URL });

    redis.on('error', err => console.error('Redis error:', err));

    await mongoClient.connect();
    await redis.connect();

    const db = mongoClient.db(DB_NAME);

    console.log('Domain verifier connected to MongoDB and Redis.');

    try {
        if (once) {
            await runVerification(db, redis, dryRun);
        } else {
            // Loop forever — Docker restart policy handles crashes
            while (true) {
                await runVerification(db, redis, dryRun);
                console.log(`Sleeping ${INTERVAL_MS / 1000 / 60} minutes until next sweep...`);
                await new Promise(r => setTimeout(r, INTERVAL_MS));
            }
        }
    } finally {
        await mongoClient.close();
        await redis.quit();
    }
}

main().catch(err => {
    console.error('Domain verifier FAILED:', err);
    process.exit(1);
});