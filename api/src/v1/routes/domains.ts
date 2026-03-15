// api/src/v1/routes/domains.ts
// ─────────────────────────────────────────────────────────────────────────────
//  Public developer API — domain listing
//
//  GET /v1/domains          → list domains available to the caller's API plan
//  GET /v1/domains/all      → same but always includes expiry metadata
//
//  Plan gating mirrors the app:
//    free / developer / startup  → free-tier domains only
//    growth / enterprise          → free + pro domains
//
//  Redis cache:  shared with the internal /domains endpoint (same keys).
//  TTL:          5 minutes — add a domain to the registry and it surfaces
//                within 5 min without a deploy.
// ─────────────────────────────────────────────────────────────────────────────
import { Router, Request, Response } from 'express';
import { client as redis } from '../../config/redis';
import {
  DOMAIN_REGISTRY,
  formatDomainForResponse,
  daysUntilExpiry,
  EXPIRY_WARN_DAYS,
} from '../../services/domain-registry';
import { CUSTOM_DOMAIN_PLANS, ApiPlanName } from '../api-plans';

const router = Router();

const CACHE_TTL = 300; // 5 min
const REDIS_KEY = (suffix: string) => `v1_domains_list:${suffix}`;

// ─────────────────────────────────────────────────────────────────────────────
//  Helper: which registry domains can this API plan see?
// ─────────────────────────────────────────────────────────────────────────────
function canSeePro(plan: ApiPlanName): boolean {
  return CUSTOM_DOMAIN_PLANS.includes(plan); // growth + enterprise
}

function buildList(plan: ApiPlanName, alwaysExpiry: boolean): object[] {
  return DOMAIN_REGISTRY
    .filter(d => d.active)
    .filter(d => canSeePro(plan) ? true : d.tier === 'free')
    .map(entry => formatDomainForResponse(entry, { alwaysExpiry }));
}

// ─────────────────────────────────────────────────────────────────────────────
//  GET /v1/domains
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', async (req: Request, res: Response): Promise<any> => {
  const plan = req.apiUser!.plan;
  const tier = canSeePro(plan) ? 'pro' : 'free';
  const key  = REDIS_KEY(tier);

  try {
    const cached = await redis.get(key);
    if (cached) {
      return res.json({ success: true, data: JSON.parse(cached), _cache: 'hit' });
    }
  } catch (_) {}

  const list = buildList(plan, false);
  redis.set(key, JSON.stringify(list), { EX: CACHE_TTL }).catch(() => {});

  return res.json({
    success: true,
    data: list,
    count: list.length,
    note: canSeePro(plan)
      ? 'Growth/Enterprise plan: free + pro domains included.'
      : 'Upgrade to Growth plan to access additional pro domains.',
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /v1/domains/all  — full metadata including expiry dates
//  Intended for dashboard integrations that want to monitor domain health.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/all', async (req: Request, res: Response): Promise<any> => {
  const plan = req.apiUser!.plan;

  const list = DOMAIN_REGISTRY
    .filter(d => d.active)
    .filter(d => canSeePro(plan) ? true : d.tier === 'free')
    .map(entry => {
      const days = daysUntilExpiry(entry);
      return {
        domain:           entry.domain,
        tier:             entry.tier,
        tags:             entry.tags ?? [],
        expires_at:       entry.expiresAt,
        expires_in_days:  days,
        expiring_soon:    days <= EXPIRY_WARN_DAYS && days > 0,
        expired:          days <= 0,
      };
    });

  return res.json({ success: true, data: list, count: list.length });
});

export default router;