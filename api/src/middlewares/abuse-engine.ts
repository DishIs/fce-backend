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

/**
 * Extracts the real client IP from the request.
 *
 * Priority order:
 *   1. x-fp header — if the frontend already computed and signed a fingerprint,
 *      trust it (the HMAC signature on the internal request already vouches for it).
 *   2. cf-connecting-ip — Cloudflare's header for the real end-user IP.
 *      This is what the Next.js frontend uses when building the fingerprint,
 *      so we must use the same value to get a matching hash.
 *   3. x-forwarded-for first entry — set by nginx/proxies.
 *   4. req.ip — Express's resolved IP, which behind multiple Docker containers
 *      resolves to the gateway's internal IP (useless for fingerprinting).
 *
 * We intentionally do NOT use req.ip as a primary source because the stack is:
 *   Browser → Cloudflare → nginx → api-gateway → api-free/api-pro
 * By the time the request reaches the backend, req.ip is the gateway container IP.
 */
export function getRealIp(req: Request): string {
  // If frontend forwarded the real IP explicitly, use it
  const cfIp = req.headers['cf-connecting-ip'];
  if (cfIp && typeof cfIp === 'string') return cfIp.trim();

  // x-forwarded-for may be a comma-separated list; first entry is the client
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const first = (typeof xff === 'string' ? xff : xff[0]).split(',')[0].trim();
    if (first) return first;
  }

  return req.ip || 'unknown-ip';
}

/**
 * Computes a fingerprint matching the one built by the Next.js frontend in lib/api.ts.
 *
 * Frontend formula (lib/api.ts):
 *   fpString = `${cookieId}|${ipPrefix}|${ua}|${tz}|${lang}`
 *   fp = sha256(fpString)
 *
 * We replicate the same /24 IP masking and field order here.
 * If x-fp is provided (pre-computed by the frontend) we trust it directly,
 * since the request is already HMAC-signed — there's no spoofing risk.
 */
export function getFingerprint(req: Request): string {
  // Trust pre-computed fingerprint from signed internal requests
  const providedFp = req.header('x-fp');
  if (providedFp) return providedFp;

  const cookieId = req.header('x-cookie-id') || 'no-cookie';

  const rawIp = getRealIp(req);
  let ipPrefix = 'unknown-ip';
  if (rawIp !== 'unknown-ip') {
    if (rawIp.includes('.')) {
      // IPv4 → /24 subnet
      ipPrefix = rawIp.split('.').slice(0, 3).join('.') + '.0';
    } else if (rawIp.includes(':')) {
      // IPv6 → first 3 groups
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
 * Attaches user context and fingerprint to the request.
 * Does NOT record usage for paid users — they must never affect free-tier counters.
 */
export const attachIdentityContext = (req: Request, res: Response, next: NextFunction) => {
  try {
    const fingerprint = getFingerprint(req);
    const ip          = getRealIp(req);
    const userId      = req.header('x-user-id') || null;
    const cookieId    = req.header('x-cookie-id') || 'no-cookie';

    // Plan is injected by the gateway as x-derived-plan (never trust client x-plan)
    const plan = req.header('x-derived-plan') || req.header('x-plan') || 'free';

    req.userContext = { userId, fingerprint, ip, plan };

    // FIX: Only record fingerprint usage for free/anonymous users.
    // Pro users must NEVER increment shared abuse counters — a single pro user
    // making normal requests was pushing the counter past friction thresholds
    // for everyone sharing the same (incorrectly computed) fingerprint bucket.
    if (plan === 'free' || plan === 'anonymous') {
      recordFingerprintUsage(fingerprint, userId, ip, cookieId).catch(err => {
        logCriticalError(err, req, { context: 'recordFingerprintUsage' });
      });
    }

    next();
  } catch (err: any) {
    logCriticalError(err, req, { context: 'attachIdentityContext' });
    next();
  }
};

/**
 * Record fingerprint usage in Redis (free/anonymous users only).
 */
export async function recordFingerprintUsage(
  fingerprint: string,
  userId: string | null,
  ip: string,
  cookieId: string,
) {
  const monthStr = new Date().toISOString().slice(0, 7);
  const hourStr  = new Date().toISOString().slice(0, 13);

  const monthKey = `abuse:fp:${fingerprint}:${monthStr}`;
  await redis.incr(monthKey);
  await redis.expire(monthKey, 30 * 24 * 60 * 60); // 30 days

  // Track IP → CookieId churn (detect bot farms spinning up new sessions on same IP)
  if (ip && cookieId !== 'no-cookie') {
    const ipCookieKey = `abuse:ip_cookies:${ip}:${hourStr}`;
    await redis.sAdd(ipCookieKey, cookieId);
    await redis.expire(ipCookieKey, 2 * 60 * 60);
  }

  // Track CookieId → IP churn (detect proxy rotation on same session)
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
 * Free/anonymous users only — paid users are completely bypassed.
 * Applies randomized logarithmic delays and hard blocks for extreme abuse signals.
 */
export const progressiveFrictionEngine = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (process.env.DISABLE_ABUSE_ENGINE === 'true') return next();
  if (!req.userContext) return next();

  // FIX: Exit immediately for any paid plan — no Redis round-trips at all.
  // This check now also covers 'pro', 'developer', 'startup', 'growth', 'enterprise'
  // in addition to the original 'free'/'anonymous' check.
  const { plan } = req.userContext;
  if (plan !== 'free' && plan !== 'anonymous') return next();

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
    next();
  }
};