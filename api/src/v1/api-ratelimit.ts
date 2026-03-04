// v1/api-ratelimit.ts
// Two-layer rate limiter + quota warning emails.
// Layers:
//   1. Per-second  — sliding window (burst protection)
//   2. Per-month   — counter, resets on calendar month
//      At 80%:  send one quota warning email (once per billing period)
//      At 100%: send one quota-exhausted email, then fallback to credits
// Credits absorb overages atomically. Never blocks on Redis error (fail open).
import { Request, Response, NextFunction } from 'express';
import { client as redis } from '../redis';
import { db } from '../mongo';
import { sendEmail } from '../email/resend';
import {
  getApiQuotaWarningEmailHtml,
  getApiQuotaExhaustedEmailHtml,
} from '../email/templates';

function currentMonthKey(): string {
  return new Date().toISOString().slice(0, 7);
}

function firstOfNextMonth(): string {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() + 1, 1).toISOString();
}

async function deductCredit(userId: string): Promise<void> {
  await db.collection('users').updateOne(
    { wyiUserId: userId, apiCredits: { $gt: 0 } },
    { $inc: { apiCredits: -1 } },
  );
}

async function maybeEmailQuota(
  userId: string, apiKeyId: string, plan: string,
  monthlyUsed: number, monthlyLimit: number, credits: number,
): Promise<void> {
  const month = currentMonthKey();
  const pct   = (monthlyUsed / monthlyLimit) * 100;

  if (pct >= 80 && pct < 100) {
    const gateKey = `quota_warn_80:${apiKeyId}:${month}`;
    const already = await redis.get(gateKey).catch(() => null);
    if (already) return;
    await redis.set(gateKey, '1', { EX: 35 * 24 * 3600 });
    const user = await db.collection('users').findOne({ wyiUserId: userId }, { projection: { email: 1 } });
    if (!user?.email) return;
    sendEmail({
      to: user.email, from: 'api',
      subject: `You have used ${Math.round(pct)}% of your API quota this month`,
      html: getApiQuotaWarningEmailHtml({
        plan, requestsUsed: monthlyUsed, requestsLimit: monthlyLimit,
        percentUsed: pct, creditsRemaining: credits, resetsAt: firstOfNextMonth(),
      }),
    }).catch(err => console.error('[api-ratelimit] Quota warning email failed:', err));
    return;
  }

  if (pct >= 100) {
    const gateKey = `quota_warn_100:${apiKeyId}:${month}`;
    const already = await redis.get(gateKey).catch(() => null);
    if (already) return;
    await redis.set(gateKey, '1', { EX: 35 * 24 * 3600 });
    const user = await db.collection('users').findOne({ wyiUserId: userId }, { projection: { email: 1 } });
    if (!user?.email) return;
    sendEmail({
      to: user.email, from: 'api',
      subject: `API monthly quota exhausted - requests are ${credits > 0 ? 'drawing from credits' : 'being rejected'}`,
      html: getApiQuotaExhaustedEmailHtml(plan, firstOfNextMonth(), credits),
    }).catch(err => console.error('[api-ratelimit] Quota exhausted email failed:', err));
  }
}

export async function apiRateLimit(req: Request, res: Response, next: NextFunction): Promise<any> {
  const apiUser = req.apiUser!;
  const { requestsPerSecond, requestsPerMonth } = apiUser.planConfig.rateLimit;
  const keyId = apiUser.apiKeyId;
  const now   = Date.now();

  try {
    // 1. Per-second sliding window
    const secKey      = `rl:s:${keyId}`;
    const windowStart = now - 1_000;
    const pipe        = redis.multi();
    pipe.zRemRangeByScore(secKey, '-inf', windowStart.toString());
    pipe.zCard(secKey);
    pipe.zAdd(secKey, { score: now, value: `${now}:${Math.random()}` });
    pipe.expire(secKey, 2);
    const results         = await pipe.exec() as unknown[];
    const currentSecCount = (results[1] as number) ?? 0;

    if (currentSecCount >= requestsPerSecond) {
      res.setHeader('X-RateLimit-Limit-Second',     requestsPerSecond);
      res.setHeader('X-RateLimit-Remaining-Second', 0);
      res.setHeader('Retry-After', '1');
      return res.status(429).json({
        success: false, error: 'rate_limit_exceeded',
        message: `Per-second limit of ${requestsPerSecond} req/s exceeded (${apiUser.plan} plan).`,
        upgrade_url: 'https://freecustom.email/api/pricing',
      });
    }

    // 2. Monthly quota
    const monthKey   = `rl:m:${keyId}:${currentMonthKey()}`;
    const monthCount = await redis.incr(monthKey);
    if (monthCount === 1) await redis.expire(monthKey, 32 * 24 * 3600);

    if (monthCount > requestsPerMonth) {
      if (apiUser.credits > 0) {
        deductCredit(apiUser.userId).catch(() => {});
        maybeEmailQuota(apiUser.userId, keyId, apiUser.plan, monthCount, requestsPerMonth, apiUser.credits).catch(() => {});
      } else {
        maybeEmailQuota(apiUser.userId, keyId, apiUser.plan, monthCount, requestsPerMonth, 0).catch(() => {});
        res.setHeader('X-RateLimit-Limit-Month',     requestsPerMonth);
        res.setHeader('X-RateLimit-Remaining-Month', 0);
        return res.status(429).json({
          success: false, error: 'monthly_quota_exceeded',
          message: `Monthly quota of ${requestsPerMonth.toLocaleString()} requests exhausted.`,
          hint:    'Purchase request credits (never expire) or upgrade your plan.',
          credits_url: 'https://freecustom.email/api/credits',
          upgrade_url: 'https://freecustom.email/api/pricing',
        });
      }
    } else {
      maybeEmailQuota(apiUser.userId, keyId, apiUser.plan, monthCount, requestsPerMonth, apiUser.credits).catch(() => {});
    }

    // 3. Headers
    res.setHeader('X-API-Plan',                    apiUser.plan);
    res.setHeader('X-RateLimit-Limit-Second',      requestsPerSecond);
    res.setHeader('X-RateLimit-Remaining-Second',  Math.max(0, requestsPerSecond - currentSecCount - 1));
    res.setHeader('X-RateLimit-Limit-Month',       requestsPerMonth);
    res.setHeader('X-RateLimit-Remaining-Month',   Math.max(0, requestsPerMonth - monthCount));
    return next();
  } catch (err) {
    console.error('[api-ratelimit] Redis error (failing open):', err);
    return next();
  }
}