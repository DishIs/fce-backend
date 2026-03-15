// api/src/v1/api-auth.ts
// ─────────────────────────────────────────────────────────────────────────────
//  Express middleware: resolve Bearer / query-param API key → req.apiUser
//  Raw keys are NEVER stored in MongoDB. Only a SHA-256 hash is persisted.
//
//  FIX: plan is now resolved via resolveEffectivePlan() instead of reading
//  user.apiPlan directly. This means cancelled subscriptions whose period has
//  elapsed are treated as 'free' on every request — not just on the dashboard.
// ─────────────────────────────────────────────────────────────────────────────
import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { db } from '../config/mongo';
import { client as redis } from '../config/redis';
import { API_PLANS, ApiPlanName, ApiPlanConfig } from './api-plans';
import { resolveEffectivePlan } from './resolve-plan';

export interface ApiUser {
  userId:     string;
  apiKeyId:   string;
  plan:       ApiPlanName;
  planConfig: ApiPlanConfig;
  credits:    number;
}

declare global {
  namespace Express {
    interface Request {
      apiUser?: ApiUser;
    }
  }
}

const CACHE_TTL = 60;

export async function apiKeyAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<any> {
  // 1. Extract key
  let rawKey: string | undefined;
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    rawKey = authHeader.slice(7).trim();
  } else if (typeof req.query.api_key === 'string') {
    rawKey = req.query.api_key.trim();
  }

  if (!rawKey) {
    return res.status(401).json({
      success: false,
      error:   'unauthorized',
      message: 'API key required. Provide via "Authorization: Bearer <key>" header or "?api_key=<key>" query param.',
      docs:    'https://freecustom.email/docs/api',
    });
  }

  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

  // 2. Redis cache
  // NOTE: We intentionally keep TTL short (60s) so that a plan expiry is
  // reflected within one minute without needing manual cache busting.
  const cacheKey = `api_key_cache:${keyHash}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      req.apiUser = JSON.parse(cached) as ApiUser;
      return next();
    }
  } catch (_) { /* Redis miss — fall through to DB */ }

  // 3. DB lookup
  try {
    const keyDoc = await db.collection('api_keys').findOne({ keyHash, active: true });
    if (!keyDoc) {
      return res.status(401).json({
        success: false,
        error:   'invalid_api_key',
        message: 'Invalid or revoked API key.',
      });
    }

    const user = await db.collection('users').findOne({
      $or: [
        { wyiUserId:          keyDoc.wyiUserId },
        { linkedProviderIds:  keyDoc.wyiUserId },
      ],
    });

    if (!user) {
      return res.status(401).json({
        success: false,
        error:   'user_not_found',
        message: 'The user account associated with this key no longer exists.',
      });
    }

    // FIX: resolve effective plan — respects cancellation periodEnd and
    // apiScheduledDowngradeAt so expired subscriptions get 'free' immediately
    const plan: ApiPlanName = resolveEffectivePlan(user);
    const planConfig = API_PLANS[plan];

    const apiUser: ApiUser = {
      userId:     user.wyiUserId,
      apiKeyId:   keyDoc._id.toString(),
      plan,
      planConfig,
      credits:    user.apiCredits ?? 0,
    };

    // 4. Cache — only cache if plan is active (not free due to expiry) to avoid
    // a cancelled user staying on their paid plan for up to 60s after expiry.
    // If they're on a legitimate paid plan, caching is safe as normal.
    const shouldCache = !(
      plan === 'free' &&
      user.apiPlan &&
      user.apiPlan !== 'free'
    );
    if (shouldCache) {
      await redis.set(cacheKey, JSON.stringify(apiUser), { EX: CACHE_TTL });
    }

    // 5. Touch lastUsedAt (fire-and-forget)
    db.collection('api_keys')
      .updateOne({ _id: keyDoc._id }, { $set: { lastUsedAt: new Date() } })
      .catch(() => {});

    req.apiUser = apiUser;
    return next();
  } catch (err) {
    console.error('[api-auth] DB error:', err);
    return res.status(500).json({
      success: false,
      error:   'server_error',
      message: 'Authentication service temporarily unavailable.',
    });
  }
}