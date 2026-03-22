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
 * Computes or retrieves a fingerprint for the request.
 */
export function getFingerprint(req: Request): string {
  // Option B: Always trust the signed IP and FP if provided, otherwise recompute
  const providedFp = req.header('x-fp');
  if (providedFp) return providedFp;
  
  // For internal requests, we just use the raw cookie ID for fingerprinting to prevent spoofing
  // if no signature is provided for the FP itself. 
  const cookieId = req.header('x-cookie-id') || 'no-cookie';
  
  const rawIp = req.ip || req.headers['x-forwarded-for'] || 'unknown-ip';
  const ipPrefix = typeof rawIp === 'string' && rawIp.includes('.')
    ? rawIp.split('.').slice(0, 3).join('.') + '.0'
    : rawIp;

  const ua = req.headers['user-agent'] || 'unknown-ua';
  const uaFamily = ua.split(' ')[0] || ua;

  const tz = req.headers['x-timezone'] || 'unknown-tz';
  const lang = req.headers['accept-language'] || 'unknown-lang';

  const raw = `${cookieId}|${ipPrefix}|${uaFamily}|${tz}|${lang}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Middleware: Identity Layer
 * Attaches user context and fingerprint to the request.
 */
export const attachIdentityContext = (req: Request, res: Response, next: NextFunction) => {
  try {
    const fingerprint = getFingerprint(req);
    const ip = (req.ip || req.headers['x-forwarded-for'] || 'unknown-ip') as string;
    const userId = req.header('x-user-id') || null;
    const cookieId = req.header('x-cookie-id') || 'no-cookie';
    
    // Securely derive plan from gateway via x-derived-plan, never trust client x-plan
    const plan = req.header('x-derived-plan') || req.header('x-plan') || 'free'; 

    req.userContext = { userId, fingerprint, ip, plan };

    // Record usage asynchronously
    recordFingerprintUsage(fingerprint, userId, ip, cookieId).catch(err => {
      logCriticalError(err, req, { context: 'recordFingerprintUsage' });
    });

    next();
  } catch (err: any) {
    logCriticalError(err, req, { context: 'attachIdentityContext' });
    next();
  }
};

/**
 * Record fingerprint usage in Redis
 */
export async function recordFingerprintUsage(fingerprint: string, userId: string | null, ip: string, cookieId: string) {
  const monthStr = new Date().toISOString().slice(0, 7);
  const hourStr = new Date().toISOString().slice(0, 13);
  
  const monthKey = `abuse:fp:${fingerprint}:${monthStr}`;
  await redis.incr(monthKey);
  await redis.expire(monthKey, 30 * 24 * 60 * 60); // 30 days
  
  // Track IP -> CookieId churn (detect bot farms spinning up new sessions on same IP)
  if (ip && cookieId !== 'no-cookie') {
      const ipCookieKey = `abuse:ip_cookies:${ip}:${hourStr}`;
      await redis.sAdd(ipCookieKey, cookieId);
      await redis.expire(ipCookieKey, 2 * 60 * 60); // 2 hours
  }

  // Track CookieId -> IP churn (detect proxy rotation on same session)
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
 * Applies delays or blocks based on fingerprint usage and cross-account farming.
 * Paid users bypass this entirely.
 */
export const progressiveFrictionEngine = async (req: Request, res: Response, next: NextFunction) => {
  if (process.env.DISABLE_ABUSE_ENGINE === 'true') return next();
  if (!req.userContext) return next();
  
  // Paid users bypass progressive friction
  if (req.userContext.plan !== 'free' && req.userContext.plan !== 'anonymous') {
    return next();
  }

  const fingerprint = req.userContext.fingerprint;
  const ip = req.userContext.ip;
  const cookieId = req.header('x-cookie-id') || 'no-cookie';
  const hourStr = new Date().toISOString().slice(0, 13);
  
  const monthKey = `abuse:fp:${fingerprint}:${new Date().toISOString().slice(0, 7)}`;
  const accountKey = `abuse:fp_accounts:${fingerprint}`;
  const ipCookieKey = `abuse:ip_cookies:${ip}:${hourStr}`;
  const cookieIpKey = `abuse:cookie_ips:${cookieId}:${hourStr}`;
  
  try {
    const [usageStr, distinctAccounts, distinctCookies, distinctIps] = await Promise.all([
      redis.get(monthKey),
      redis.sCard(accountKey),
      redis.sCard(ipCookieKey),
      redis.sCard(cookieIpKey)
    ]);
    const usage = usageStr ? parseInt(usageStr, 10) : 0;

    // Hard block for extreme proxy rotation or farm behavior
    if (distinctCookies > 50 || distinctIps > 20) {
      notifyAnomaly('abuse_429', `Fingerprint: ${fingerprint}, Cookies: ${distinctCookies}, IPs: ${distinctIps}`).catch(() => {});
      return res.status(429).json({ success: false, error: 'too_many_requests', message: 'Suspicious behavior detected.' });
    }

    // Apply increased friction if >5 accounts created from single fingerprint (No hard block for NATs)
    if (distinctAccounts > 5) {
      const delayMs = 500 + Math.random() * 1500; // Increased delay instead of hard block
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }

    // Hard limit per fingerprint (e.g. 5000 requests per month across all accounts)
    if (usage > 5000) {
      return res.status(429).json({
        success: false,
        error: 'too_many_requests',
        message: 'Global usage limit exceeded for this device/network.'
      });
    }

    // Non-linear, randomized progressive delay
    // delay = random(100–400ms) * log(requests)
    if (usage > 1000) {
      const baseDelay = 100 + Math.random() * 300; // 100-400ms
      const multiplier = Math.max(1, Math.log10(usage) - 2); // scales slowly after 1k
      const delayMs = Math.floor(baseDelay * multiplier);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }

    next();
  } catch (err: any) {
    logCriticalError(err, req, { context: 'progressiveFrictionEngine' });
    next();
  }
};
