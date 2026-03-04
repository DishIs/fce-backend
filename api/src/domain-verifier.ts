// api/src/domain-verifier.ts  (nodemailer → Resend)
import { MongoClient, ObjectId } from 'mongodb';
import { createClient }          from 'redis';
import * as dns                  from 'dns/promises';
import dotenv                    from 'dotenv';
import { sendEmail }             from './email/resend';
import { getDomainRevocationEmailHtml, getDomainWarningEmailHtml } from './email/templates';
dotenv.config();

const MONGO_URI        = process.env.MONGO_URI  || 'mongodb://localhost:27017';
const REDIS_URL        = process.env.REDIS_URL  || 'redis://localhost:6379';
const DB_NAME          = 'freecustomemail';
const INTERVAL_MS      = parseInt(process.env.VERIFY_INTERVAL_MS || '', 10) || 6 * 60 * 60 * 1000;
const FAILURE_THRESHOLD = parseInt(process.env.FAILURE_THRESHOLD || '', 10) || 2;
const OUR_MX_SUFFIX    = (process.env.OUR_MX_SUFFIX || 'mx.freecustom.email').toLowerCase();
const VERIFIED_DOMAINS_KEY = 'verified_custom_domains';
const MAIL_DISABLED    = process.env.MAIL_DISABLED === 'true';

interface DomainRecord {
  domain: string; verified: boolean; txtRecord: string; mxRecord?: string; dnsFailures?: number;
}
interface ProUser {
  _id: ObjectId; email: string; customDomains: DomainRecord[];
}
interface VerifyResult {
  domain: string; txtOk: boolean; mxOk: boolean; revoked: boolean; warningSent: boolean; error?: string;
}

async function sendWarningEmail(toEmail: string, domain: string, txtOk: boolean, mxOk: boolean) {
  if (MAIL_DISABLED) { console.log(`  [resend] Warning email skipped (disabled)`); return; }
  const { error } = await sendEmail({
    to: toEmail, from: 'domains',
    subject: `Action required: DNS issue detected for ${domain}`,
    html: getDomainWarningEmailHtml(domain, txtOk, mxOk),
  });
  if (error) console.error(`  [resend] Warning email failed for ${domain}:`, error);
  else console.log(`  [resend] Warning email sent to ${toEmail} for ${domain}`);
}

async function sendRevocationEmail(toEmail: string, domain: string, txtOk: boolean, mxOk: boolean) {
  if (MAIL_DISABLED) { console.log(`  [resend] Revocation email skipped (disabled)`); return; }
  const { error } = await sendEmail({
    to: toEmail, from: 'domains',
    subject: `Custom domain ${domain} has been de-verified`,
    html: getDomainRevocationEmailHtml(domain, txtOk, mxOk),
  });
  if (error) console.error(`  [resend] Revocation email failed for ${domain}:`, error);
  else console.log(`  [resend] Revocation email sent to ${toEmail} for ${domain}`);
}

async function checkTxt(domain: string, expected: string): Promise<boolean> {
  const records = await dns.resolveTxt(domain);
  const norm    = expected.trim();
  return records.map(c => c.join('').trim()).some(v => v === norm);
}

async function checkMx(domain: string): Promise<boolean> {
  const records = await dns.resolveMx(domain);
  return records.some(mx => {
    const exchange = mx.exchange.toLowerCase().replace(/\.$/, '');
    return exchange === OUR_MX_SUFFIX || exchange.endsWith(`.${OUR_MX_SUFFIX.split('.').slice(1).join('.')}`);
  });
}

async function verifyDomain(
  db: any, redis: ReturnType<typeof createClient>,
  user: ProUser, rec: DomainRecord, dryRun: boolean,
): Promise<VerifyResult> {
  const { domain, txtRecord } = rec;
  let txtOk = false, mxOk = false, dnsErr: string | undefined;

  try {
    [txtOk, mxOk] = await Promise.all([
      checkTxt(domain, txtRecord).catch(() => false),
      checkMx(domain).catch((err) => {
        if (err.code === 'ENODATA' || err.code === 'ENOTFOUND') return false;
        throw err;
      }),
    ]);
  } catch (err: any) {
    dnsErr = err.message;
    console.warn(`  [${domain}] DNS error: ${dnsErr}`);
  }

  const passed        = txtOk && mxOk && !dnsErr;
  const currentFails  = rec.dnsFailures ?? 0;
  const newFails      = passed ? 0 : currentFails + 1;
  const shouldRevoke  = !passed && newFails >= FAILURE_THRESHOLD;
  const result: VerifyResult = { domain, txtOk, mxOk, revoked: false, warningSent: false, error: dnsErr };

  if (dryRun) {
    if (shouldRevoke) { console.log(`  [DRY RUN] Would revoke ${domain}`); result.revoked = true; }
    else if (!passed)  console.log(`  [${domain}] Failure ${newFails}/${FAILURE_THRESHOLD}`);
    return result;
  }

  if (passed) {
    if (currentFails > 0) {
      await db.collection('users').updateOne(
        { _id: user._id, 'customDomains.domain': domain },
        { $set: { 'customDomains.$.dnsFailures': 0 } },
      );
    }
    await redis.sAdd(VERIFIED_DOMAINS_KEY, domain);
    return result;
  }

  await db.collection('users').updateOne(
    { _id: user._id, 'customDomains.domain': domain },
    { $set: { 'customDomains.$.dnsFailures': newFails } },
  );

  if (shouldRevoke) {
    await db.collection('users').updateOne(
      { _id: user._id, 'customDomains.domain': domain },
      { $set: { 'customDomains.$.verified': false, 'customDomains.$.dnsFailures': 0 } },
    );
    await redis.sRem(VERIFIED_DOMAINS_KEY, domain);
    result.revoked = true;
    console.log(`  [${domain}] REVOKED after ${newFails} failures`);
    sendRevocationEmail(user.email, domain, txtOk, mxOk).catch(() => {});
  } else {
    console.log(`  [${domain}] Failure ${newFails}/${FAILURE_THRESHOLD} — not revoking yet`);
    if (currentFails === 0) {
      result.warningSent = true;
      sendWarningEmail(user.email, domain, txtOk, mxOk).catch(() => {});
    }
  }

  return result;
}

async function runVerification(db: any, redis: ReturnType<typeof createClient>, dryRun: boolean): Promise<void> {
  const now = new Date();
  console.log('\n' + '='.repeat(60));
  console.log(`Domain Verification Sweep — ${now.toISOString()} | Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log('='.repeat(60));

  const users: ProUser[] = await db.collection('users')
    .find({ plan: 'pro', 'customDomains.verified': true })
    .project({ _id: 1, email: 1, customDomains: 1 })
    .toArray();

  const verifiedDomains = users.flatMap(u => (u.customDomains || []).filter(d => d.verified));
  console.log(`\nFound ${verifiedDomains.length} verified domain(s) across ${users.length} pro user(s)\n`);

  let passed = 0, revoked = 0, pending = 0, warnings = 0;

  for (const user of users) {
    const domains = (user.customDomains || []).filter(d => d.verified);
    if (!domains.length) continue;
    console.log(`User: ${user.email}`);
    for (const rec of domains) {
      const result = await verifyDomain(db, redis, user, rec, dryRun);
      if (result.revoked)                      revoked++;
      else if (!result.txtOk || !result.mxOk) pending++;
      else                                     passed++;
      if (result.warningSent) warnings++;
    }
  }

  if (!dryRun) {
    const allVerified = new Set(verifiedDomains.map(d => d.domain));
    const allInRedis  = await redis.sMembers(VERIFIED_DOMAINS_KEY);
    const stale       = allInRedis.filter(d => !allVerified.has(d));
    if (stale.length > 0) {
      await redis.sRem(VERIFIED_DOMAINS_KEY, stale);
      console.log(`\nEvicted ${stale.length} stale Redis entries: ${stale.join(', ')}`);
    }
  }

  console.log('\n' + '-'.repeat(60));
  console.log(`Results — passed: ${passed}  pending: ${pending}  revoked: ${revoked}  warnings: ${warnings}`);
  console.log('='.repeat(60) + '\n');
}

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
  console.log('Domain verifier connected.');

  try {
    if (once) {
      await runVerification(db, redis, dryRun);
    } else {
      while (true) {
        await runVerification(db, redis, dryRun);
        console.log(`Sleeping ${INTERVAL_MS / 1000 / 60} min until next sweep...`);
        await new Promise(r => setTimeout(r, INTERVAL_MS));
      }
    }
  } finally {
    await mongoClient.close();
    await redis.quit();
  }
}

main().catch(err => { console.error('Domain verifier FAILED:', err); process.exit(1); });