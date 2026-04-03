// api/src/middlewares/abuse-engine.ts
import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { client as redis } from '../config/redis';
import { logCriticalError } from '../utils/logger';
import { notifyAnomaly } from '../utils/alerts';

export interface UserContext {
  userId: string | null;
  fingerprint: string;
  ip: string;
  plan: string;
}

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
  const hourStr  = new Date().toISOString().slice(0, 13);

  const monthKey = `abuse:fp:${fingerprint}:${monthStr}`;
  await redis.incr(monthKey);
  await redis.expire(monthKey, 30 * 24 * 60 * 60); // 30 days

  if (ip && cookieId !== 'no-cookie') {
    const ipCookieKey = `abuse:ip_cookies:${ip}:${hourStr}`;
    await redis.sAdd(ipCookieKey, cookieId);
    await redis.expire(ipCookieKey, 2 * 60 * 60);
  }

  if (cookieId !== 'no-cookie' && ip) {
    const cookieIpKey = `abuse:cookie_ips:${cookieId}:${hourStr}`;
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
  const { plan } = req.userContext;
  if (plan !== 'free' && plan !== 'anonymous') return next();

  // ── Gate 2: management / internal paths — never throttle ─────────────────
  // Management paths are signed internal calls from our own frontend.
  // They are already protected by x-internal-api-key + HMAC; adding
  // fingerprint friction here blocks legitimate free-plan dashboard usage.
  if (!isPublicApiPath(req)) return next();

  const { fingerprint, ip } = req.userContext;
  const cookieId  = req.header('x-cookie-id') || 'no-cookie';
  const hourStr   = new Date().toISOString().slice(0, 13);
  const monthStr  = new Date().toISOString().slice(0, 7);

  const monthKey    = `abuse:fp:${fingerprint}:${monthStr}`;
  const accountKey  = `abuse:fp_accounts:${fingerprint}`;
  const ipCookieKey = `abuse:ip_cookies:${ip}:${hourStr}`;
  const cookieIpKey = `abuse:cookie_ips:${cookieId}:${hourStr}`;

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

    // Hard limit: 5000 requests/month per fingerprint
    if (usage > 5000) {
      return res.status(429).json({
        success: false,
        error:   'too_many_requests',
        message: 'Global usage limit exceeded for this device/network.',
      });
    }

    // Progressive delay above 1000 requests
    if (usage > 1000) {
      const baseDelay  = 100 + Math.random() * 300;
      const multiplier = Math.max(1, Math.log10(usage) - 2);
      const delayMs    = Math.floor(baseDelay * multiplier);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }

    next();
  } catch (err: any) {
    logCriticalError(err, req, { context: 'progressiveFrictionEngine' });
    return res.status(500).json({ success: false, error: 'internal_error', message: 'Abuse check failed due to internal error.' });
  }
};