// api/src/middlewares/abuse-engine.ts
import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { client as redis } from '../config/redis';
import { db } from '../config/mongo';
import { logCriticalError } from '../utils/logger';
import { notifyAnomaly } from '../utils/alerts';
import { sendEmail } from '../email/resend';

export interface UserContext {
  userId: string | null;
  fingerprint: string;
  ip: string;
  plan: string;
}

// Auto-warn threshold: fingerprints hitting this many requests get flagged
const AUTO_WARN_THRESHOLD = 5000;

declare global {
  namespace Express {
    interface Request {
      userContext?: UserContext;
    }
  }
}

// ── Path classification ───────────────────────────────────────────────────────
//
// Friction and fingerprint-usage recording ONLY apply to public-facing API
// paths where free-tier abuse actually happens.
//
// Management paths (/user/*, /auth/*, /paddle/*, /health) are called by our
// own frontend via the internal API key + HMAC signature.  They are already
// protected at the transport layer; adding fingerprint friction to them
// causes legitimate free users and "power users" to hit rate-limits just
// from normal dashboard usage (page loads, settings fetches, etc.).
//
// Public API paths that should have friction:
//   /v1/*       — developer REST API  (NOTE: these go through createPublicV1Router,
//                  which does NOT include internalApiAuth, so this middleware only
//                  applies to /mailbox/* currently — but the check is future-proof)
//   /mailbox/*  — real-time mailbox reads

function isPublicApiPath(req: Request): boolean {
  const path = req.path || '';
  return (
    path.startsWith('/v1/') ||
    path === '/v1' ||
    path.startsWith('/mailbox/')
  );
}

/**
 * Extracts the real client IP from the request.
 *
 * Priority order:
 *   1. cf-connecting-ip — Cloudflare's header for the real end-user IP.
 *   2. x-forwarded-for first entry — set by nginx/proxies.
 *   3. req.ip — Express's resolved IP (useless behind multiple containers).
 */
export function getRealIp(req: Request): string {
  const cfIp = req.headers['cf-connecting-ip'];
  if (cfIp && typeof cfIp === 'string') return cfIp.trim();

  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const first = (typeof xff === 'string' ? xff : xff[0]).split(',')[0].trim();
    if (first) return first;
  }

  return req.ip || 'unknown-ip';
}

/**
 * Computes a fingerprint matching the one built by the Next.js frontend.
 *
 * Frontend formula (lib/api.ts):
 *   fpString = `${cookieId}|${ipPrefix}|${ua}|${tz}|${lang}`
 *   fp = sha256(fpString)
 *
 * If x-fp is provided (pre-computed by the frontend) we trust it directly.
 */
export function getFingerprint(req: Request): string {
  const providedFp = req.header('x-fp');
  if (providedFp) return providedFp;

  const cookieId = req.header('x-cookie-id') || 'no-cookie';

  const rawIp = getRealIp(req);
  let ipPrefix = 'unknown-ip';
  if (rawIp !== 'unknown-ip') {
    if (rawIp.includes('.')) {
      ipPrefix = rawIp.split('.').slice(0, 3).join('.') + '.0';
    } else if (rawIp.includes(':')) {
      ipPrefix = rawIp.split(':').slice(0, 3).join(':') + '::';
    }
  }

  const ua       = req.headers['user-agent'] || 'unknown-ua';
  const uaFamily = ua.split(' ')[0] || ua;
  const tz       = req.headers['x-timezone'] || 'unknown-tz';
  const lang     = req.headers['accept-language'] || 'unknown-lang';

  const raw = `${cookieId}|${ipPrefix}|${uaFamily}|${tz}|${lang}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

async function getUserBanStatus(userId: string): Promise<{ status: string; reason?: string }> {
  if (!userId) return { status: 'none' };
  
  const cacheKey = `ban_cache:${userId}`;
  const cached = await redis.get(cacheKey);
  if (cached) {
    const data = JSON.parse(cached);
    return { status: data.status, reason: data.reason };
  }
  
  const user = await db.collection('users').findOne(
    { $or: [{ wyiUserId: userId }, { linkedProviderIds: userId }] },
    { projection: { banStatus: 1, banReason: 1 } }
  );
  
  if (!user) return { status: 'none' };
  const result = {
    status: (user as any).banStatus || 'none',
    reason: (user as any).banReason
  };
  
  // Cache for 5 minutes
  await redis.set(cacheKey, JSON.stringify(result), { EX: 300 });
  return result;
}

export async function invalidateBanCache(userId: string): Promise<void> {
  if (!userId) return;
  await redis.del(`ban_cache:${userId}`);
}

async function warnAbusiveFingerprint(fingerprint: string, userId: string, usage: number): Promise<void> {
  if (!userId || userId.startsWith('rapidapi:')) return;
  
  const user = await db.collection('users').findOne(
    { $or: [{ wyiUserId: userId }, { linkedProviderIds: userId }] },
    { projection: { banStatus: 1, email: 1, name: 1 } }
  );
  
  if (!user) return;
  
  const currentBanStatus = (user as any).banStatus || 'none';
  
  if (currentBanStatus === 'none') {
    await db.collection('users').updateOne(
      { _id: user._id },
      { 
        $set: { 
          banStatus: 'warned', 
          banReason: 'You know why you are seeing this, right? I\'m running this service solo, I hope you understand this. You can also contact me if you have issues and can\'t afford our plan, I\'ll be happy to help :)',
          banAt: new Date()
        } 
      }
    );
    
    const adminEmail = process.env.ADMIN_EMAIL || 'dishantsinghdev@icloud.com';
    
    await sendEmail({
      to: adminEmail,
      subject: `[ABUSE WARNING] User ${(user as any).email} hit ${usage} requests`,
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2>API Abuse Warning</h2>
          <p><strong>Email:</strong> ${(user as any).email}</p>
          <p><strong>Name:</strong> ${(user as any).name || 'N/A'}</p>
          <p><strong>User ID:</strong> ${userId}</p>
          <p><strong>Fingerprint:</strong> ${fingerprint}</p>
          <p><strong>Usage:</strong> ${usage} requests this month</p>
          <p><strong>Status:</strong> Warned</p>
          <hr/>
          <p>Action needed: Review and decide on ban.</p>
        </div>
      `,
      from: 'api'
    });
    
    await invalidateBanCache(userId);
    notifyAnomaly('user_warned', `Fingerprint: ${fingerprint}, User: ${userId}, Usage: ${usage}`).catch(() => {});
  }
}

async function banAbusiveUser(userId: string): Promise<void> {
  if (!userId || userId.startsWith('rapidapi:')) return;
  
  const user = await db.collection('users').findOne(
    { $or: [{ wyiUserId: userId }, { linkedProviderIds: userId }] },
    { projection: { banStatus: 1, email: 1, name: 1 } }
  );
  
  if (!user) return;
  
  const currentBanStatus = (user as any).banStatus || 'none';
  
  if (currentBanStatus === 'warned') {
    await db.collection('users').updateOne(
      { _id: user._id },
      { 
        $set: { 
          banStatus: 'banned', 
          banReason: 'Continued API abuse after warning',
          banAt: new Date()
        } 
      }
    );
    
    await invalidateBanCache(userId);
    notifyAnomaly('user_banned', `User: ${userId} banned for continued API abuse`).catch(() => {});
  }
}

async function notifyAdminOfMultipleWarnings(warnedUsers: { email: string; name: string; usage: number }[]): Promise<void> {
  if (warnedUsers.length === 0) return;
  
  const adminEmail = process.env.ADMIN_EMAIL || 'dishantsinghdev@icloud.com';
  
    const userListHtml = warnedUsers.map(u => 
    `<li>${u.email} (${u.name || 'N/A'}) - ${u.usage} requests</li>`
  ).join('');
  
  await sendEmail({
    to: adminEmail,
    subject: `[ALERT] ${warnedUsers.length} users warned for API abuse`,
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h2>API Abuse Warning</h2>
        <p>The following users have been automatically warned for high API usage:</p>
        <ul>${userListHtml}</ul>
        <p>Check the dashboard for more details.</p>
      </div>
    `,
    from: 'api'
  });
}

/**
 * Middleware: Identity Layer
 *
 * Attaches user context and fingerprint to the request.
 *
 * Fingerprint USAGE (Redis counters) is only recorded for:
 *   - free / anonymous plans
 *   - public API paths (/v1/*, /mailbox/*)
 *
 * Management paths (/user/*, /auth/*, etc.) are NEVER recorded so that
 * normal dashboard activity doesn't inflate abuse counters.
 */
export const attachIdentityContext = (req: Request, res: Response, next: NextFunction) => {
  try {
    const fingerprint = getFingerprint(req);
    const ip          = getRealIp(req);
    const userId      = req.header('x-user-id') || null;
    const cookieId    = req.header('x-cookie-id') || 'no-cookie';

    const plan = req.header('x-derived-plan') || req.header('x-plan') || 'free';

    req.userContext = { userId, fingerprint, ip, plan };

    // Only record fingerprint usage for free/anonymous users on public API paths.
    // Never record for management paths — dashboard calls must never consume
    // abuse counters shared with real API traffic.
    if (
      (plan === 'free' || plan === 'anonymous') &&
      isPublicApiPath(req)
    ) {
      recordFingerprintUsage(fingerprint, userId, ip, cookieId, plan).catch(err => {
        logCriticalError(err, req, { context: 'recordFingerprintUsage' });
      });
    }

    next();
  } catch (err: any) {
    logCriticalError(err, req, { context: 'attachIdentityContext' });
    return res.status(500).json({ success: false, error: 'internal_error', message: 'Identity check failed due to internal error.' });
  }
};

/**
 * Record fingerprint usage in Redis (public API + free/anonymous only).
 */
export async function recordFingerprintUsage(
  fingerprint: string,
  userId: string | null,
  ip: string,
  cookieId: string,
  plan: string = 'free',
) {
  if (plan !== 'free' && plan !== 'anonymous') return;

  const monthStr = new Date().toISOString().slice(0, 7);

  const monthKey = `abuse:fp:${fingerprint}:${monthStr}`;
  const usage = await redis.incr(monthKey);
  
  // Adaptive TTL: Drive-by bots get 24h, consistent users get 30d
  if (usage === 1) {
    await redis.expire(monthKey, 24 * 60 * 60); // 1 day
  } else if (usage === 10) {
    await redis.expire(monthKey, 30 * 24 * 60 * 60); // 30 days
  }

  // Sliding window instead of per-hour partitioning reduces keys by 24x
  if (ip && cookieId !== 'no-cookie') {
    const ipCookieKey = `abuse:ip_cookies:${ip}`;
    await redis.sAdd(ipCookieKey, cookieId);
    await redis.expire(ipCookieKey, 2 * 60 * 60);
  }

  if (cookieId !== 'no-cookie' && ip) {
    const cookieIpKey = `abuse:cookie_ips:${cookieId}`;
    await redis.sAdd(cookieIpKey, ip);
    await redis.expire(cookieIpKey, 2 * 60 * 60);
  }

  if (userId && !userId.startsWith('rapidapi:')) {
    const accountKey = `abuse:fp_accounts:${fingerprint}`;
    await redis.sAdd(accountKey, userId);
    await redis.expire(accountKey, 30 * 24 * 60 * 60);
  }
}

/**
 * Middleware: Progressive Friction Engine
 *
 * ONLY applied when BOTH conditions are true:
 *   1. The plan is free or anonymous
 *   2. The path is a public API path (/v1/*, /mailbox/*)
 *
 * Management paths (/user/*, /auth/*, /paddle/*, etc.) are completely
 * bypassed — internal dashboard calls must never be throttled by this engine.
 * Paid users are also completely bypassed.
 */
export const progressiveFrictionEngine = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (process.env.DISABLE_ABUSE_ENGINE === 'true') return next();
  if (!req.userContext) return next();

  // ── Gate 1: paid users — instant exit, no Redis round-trips ──────────────
  const { plan, userId } = req.userContext;
  if (plan !== 'free' && plan !== 'anonymous') return next();

  // ── Gate 2: management / internal paths — never throttle ─────────────────
  // Management paths are signed internal calls from our own frontend.
  // They are already protected by x-internal-api-key + HMAC; adding
  // fingerprint friction here blocks legitimate free-plan dashboard usage.
  if (!isPublicApiPath(req)) return next();

  // ── Gate 3: Check ban status for API abuse ─────────────────────────────
  if (userId) {
    const banInfo = await getUserBanStatus(userId);
    if (banInfo.status === 'banned') {
      return res.status(403).json({
        success: false,
        error: 'account_banned',
        message: 'Your account has been suspended due to policy violations.',
        banStatus: 'banned',
        banReason: banInfo.reason || 'Policy violation.',
        contactEmail: 'support@freecustom.email',
      });
    }
  }

  const { fingerprint, ip } = req.userContext;
  const cookieId  = req.header('x-cookie-id') || 'no-cookie';
  const monthStr  = new Date().toISOString().slice(0, 7);

  const monthKey    = `abuse:fp:${fingerprint}:${monthStr}`;
  const accountKey  = `abuse:fp_accounts:${fingerprint}`;
  // Use the sliding window keys instead of hourly partitioned keys
  const ipCookieKey = `abuse:ip_cookies:${ip}`;
  const cookieIpKey = `abuse:cookie_ips:${cookieId}`;

  try {
    const [usageStr, distinctAccounts, distinctCookies, distinctIps] = await Promise.all([
      redis.get(monthKey),
      redis.sCard(accountKey),
      redis.sCard(ipCookieKey),
      redis.sCard(cookieIpKey),
    ]);
    const usage = usageStr ? parseInt(usageStr, 10) : 0;
    // Hard block: extreme proxy rotation or cookie farm
    if (distinctCookies > 50 || distinctIps > 20) {
        await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 2000)); // slow-down
        notifyAnomaly(
            'abuse_429',
            `Fingerprint: ${fingerprint}, Cookies: ${distinctCookies}, IPs: ${distinctIps}`,
        ).catch(() => {});
        return res.status(429).json({
            success: false,
            error:   'too_many_requests',
            message: 'Suspicious behavior detected.',
        });
    }
// Friction: >5 accounts from same fingerprint
    if (distinctAccounts > 5) {
      const delayMs = 500 + Math.random() * 1500;
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }

    // Hard limit: 5000 requests/month per fingerprint - add heavy friction, no ban
    if (usage > 5000) {
      const delayMs = 2000 + Math.random() * 1000;
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }

    // Auto-warn fingerprints crossing threshold (only once per fingerprint)
    if (usage > AUTO_WARN_THRESHOLD && userId) {
      const alreadyWarnedKey = `abuse:warned:${fingerprint}`;
      const alreadyWarned = await redis.get(alreadyWarnedKey);
      if (!alreadyWarned) {
        await warnAbusiveFingerprint(fingerprint, userId, usage);
        await redis.set(alreadyWarnedKey, '1', { EX: 30 * 24 * 60 * 60 });
      }
    }

    // Additional friction for warned users (2x delay) - cached for 5 min
    let additionalFriction = 1;
    if (userId) {
      const banInfo = await getUserBanStatus(userId);
      if (banInfo.status === 'warned') {
        additionalFriction = 2;
      }
    }

    // Progressive delay above 1000 requests
    if (usage > 1000) {
      const baseDelay  = 100 + Math.random() * 300;
      const multiplier = Math.max(1, Math.log10(usage) - 2);
      const delayMs    = Math.floor(baseDelay * multiplier * additionalFriction);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }

    next();
  } catch (err: any) {
    logCriticalError(err, req, { context: 'progressiveFrictionEngine' });
    return res.status(500).json({ success: false, error: 'internal_error', message: 'Abuse check failed due to internal error.' });
  }
};