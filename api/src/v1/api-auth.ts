// v1/api-auth.ts
// ─────────────────────────────────────────────────────────────────────────────
//  Express middleware: resolve Bearer / query-param API key → req.apiUser
//  Raw keys are NEVER stored in MongoDB. Only a SHA-256 hash is persisted.
// ─────────────────────────────────────────────────────────────────────────────
import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { db } from '../mongo';
import { client as redis } from '../redis';
import { API_PLANS, ApiPlanName, ApiPlanConfig } from './api-plans';

// ── Augment Express Request ───────────────────────────────────────────────────
export interface ApiUser {
  userId:     string;       // wyiUserId
  apiKeyId:   string;       // api_keys._id (string)
  plan:       ApiPlanName;
  planConfig: ApiPlanConfig;
  credits:    number;       // remaining request credits (never expire)
}

declare global {
  namespace Express {
    interface Request {
      apiUser?: ApiUser;
    }
  }
}

// ── Key cache TTL (seconds) ───────────────────────────────────────────────────
const CACHE_TTL = 60;

// ── Middleware ────────────────────────────────────────────────────────────────
export async function apiKeyAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<any> {
  // 1. Extract key — Authorization: Bearer <key>  OR  ?api_key=<key>
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
      error: 'unauthorized',
      message:
        'API key required. Provide via "Authorization: Bearer <key>" header or "?api_key=<key>" query param.',
      docs: 'https://freecustom.email/docs/api',
    });
  }

  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

  // 2. Redis cache — avoids a DB round-trip on every request
  const cacheKey = `api_key_cache:${keyHash}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      req.apiUser = JSON.parse(cached) as ApiUser;
      return next();
    }
  } catch (_) { /* Redis miss is fine — fall through to DB */ }

  // 3. DB lookup
  try {
    const keyDoc = await db.collection('api_keys').findOne({
      keyHash,
      active: true,
    });

    if (!keyDoc) {
      return res.status(401).json({
        success: false,
        error: 'invalid_api_key',
        message: 'Invalid or revoked API key.',
      });
    }

    const user = await db.collection('users').findOne({
      $or: [
        { wyiUserId: keyDoc.wyiUserId },
        { linkedProviderIds: keyDoc.wyiUserId },
      ],
    });

    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'user_not_found',
        message: 'The user account associated with this key no longer exists.',
      });
    }

    const plan: ApiPlanName = (user.apiPlan as ApiPlanName) ?? 'free';
    const planConfig = API_PLANS[plan];

    const apiUser: ApiUser = {
      userId:     user.wyiUserId,
      apiKeyId:   keyDoc._id.toString(),
      plan,
      planConfig,
      credits:    user.apiCredits ?? 0,
    };

    // 4. Warm the cache
    await redis.set(cacheKey, JSON.stringify(apiUser), { EX: CACHE_TTL });

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
      error: 'server_error',
      message: 'Authentication service temporarily unavailable.',
    });
  }
}