// domains.ts
// ─────────────────────────────────────────────────────────────────────────────
//  Internal /domains endpoint — served to the Next.js frontend.
//
//  Auth:  Optional JWT (same token the frontend already mints in
//         private-mailbox/route.ts via signServiceToken).
//         • No token / invalid token → free domains only.
//         • Valid token with plan='pro' → free + pro domains.
//
//  Caching:  Redis with a 5-min TTL per tier key so the registry file is
//            read once at startup and then served from memory.
// ─────────────────────────────────────────────────────────────────────────────
import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import ratelimit from './ratelimit';
import { client as redis } from './redis';
import {
  DOMAIN_REGISTRY,
  DomainTier,
  formatDomainForResponse,
  EXPIRY_WARN_DAYS,
  daysUntilExpiry,
} from './domain-registry';

const JWT_SECRET = process.env.JWT_SECRET!;

// Redis cache TTLs
const CACHE_TTL_SECONDS = 300; // 5 min — short enough to pick up new domains fast
const REDIS_KEY_FREE     = 'domains_list:free';
const REDIS_KEY_PRO      = 'domains_list:pro';   // free + pro combined

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────────

type PlanTier = 'anonymous' | 'free' | 'pro';

/** Extract plan from the Authorization header JWT.  Never throws. */
function extractPlanFromToken(authHeader: string | undefined): PlanTier {
  if (!authHeader?.startsWith('Bearer ')) return 'anonymous';
  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { plan?: string };
    if (payload.plan === 'pro') return 'pro';
    if (payload.plan === 'free') return 'free';
    return 'anonymous';
  } catch {
    return 'anonymous';
  }
}

/** Build the domain list for a given plan tier, with expiry data. */
function buildDomainList(tier: PlanTier): object[] {
  return DOMAIN_REGISTRY
    .filter(d => d.active)
    .filter(d => tier === 'pro' ? true : d.tier === 'free')
    .map(entry => formatDomainForResponse(entry, { alwaysExpiry: false }));
}

/** Cache key per tier */
function cacheKey(tier: PlanTier): string {
  return tier === 'pro' ? REDIS_KEY_PRO : REDIS_KEY_FREE;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Handler
// ─────────────────────────────────────────────────────────────────────────────
export async function domainsHandler(req: Request, res: Response): Promise<void> {
  const ip = req.ip;

  try {
    await ratelimit(ip);
  } catch {
    res.status(429).json({ success: false, message: 'Too many requests.' });
    return;
  }

  const plan = extractPlanFromToken(req.headers.authorization);
  const key  = cacheKey(plan);

  // ── Try Redis cache first ────────────────────────────────────────────────
  try {
    const cached = await redis.get(key);
    if (cached) {
      const parsed = JSON.parse(cached) as object[];
      res.status(200).json({ success: true, data: parsed, cached: true });
      return;
    }
  } catch (_) {
    // cache miss — fall through to build fresh
  }

  // ── Build fresh list ─────────────────────────────────────────────────────
  const list = buildDomainList(plan);

  // Write-through cache (fire and forget — don't block the response)
  redis.set(key, JSON.stringify(list), { EX: CACHE_TTL_SECONDS }).catch(() => {});

  res.status(200).json({ success: true, data: list });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Cache invalidation helper — call this whenever the registry changes
//  (e.g. from an admin endpoint or a deploy hook).
// ─────────────────────────────────────────────────────────────────────────────
export async function invalidateDomainCache(): Promise<void> {
  await Promise.allSettled([
    redis.del(REDIS_KEY_FREE),
    redis.del(REDIS_KEY_PRO),
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
//  GET /domains/expiry  — authenticated-only: returns expiry dates for ALL
//  domains the calling user is eligible to see (used by the dashboard).
//  Requires a valid JWT regardless of plan.
// ─────────────────────────────────────────────────────────────────────────────
export async function domainExpiryHandler(req: Request, res: Response): Promise<void> {
  const plan = extractPlanFromToken(req.headers.authorization);
  if (plan === 'anonymous') {
    res.status(401).json({ success: false, message: 'Authorization required.' });
    return;
  }

  const list = DOMAIN_REGISTRY
    .filter(d => d.active)
    .filter(d => plan === 'pro' ? true : d.tier === 'free')
    .map(entry => {
      const days = daysUntilExpiry(entry);
      return {
        domain:         entry.domain,
        tier:           entry.tier,
        expires_at:     entry.expiresAt,
        expires_in_days: days,
        expiring_soon:  days <= EXPIRY_WARN_DAYS && days > 0,
        expired:        days <= 0,
      };
    });

  res.status(200).json({ success: true, data: list });
}