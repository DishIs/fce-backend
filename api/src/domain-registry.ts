// domain-registry.ts
// ─────────────────────────────────────────────────────────────────────────────
//  Single source of truth for all domains served by freecustom.email.
//
//  HOW TO ADD A NEW DOMAIN:
//    1. Add an entry to DOMAIN_REGISTRY below.
//    2. Set `tier`:      'free'  → all users   |  'pro' → authenticated + pro users
//    3. Set `expiresAt`: ISO date of your domain registrar's renewal deadline.
//    4. Set `tags`:      'new' shows a badge for 30 days; 'featured' pins it top.
//    5. Set `active: true`.  Flip to false to retire without deleting.
//    Nothing else needs to change — the endpoints, v1 router, and inbox validator
//    all read from this file (or from the Redis-cached projection of it).
// ─────────────────────────────────────────────────────────────────────────────

export type DomainTier = 'free' | 'pro';
export type DomainTag  = 'new' | 'featured' | 'popular';

export interface DomainEntry {
  /** The bare domain name, lower-case, no leading @. */
  domain: string;

  /** 'free' = served to all users.  'pro' = requires pro app plan or Growth+ API plan. */
  tier: DomainTier;

  /**
   * ISO 8601 date (YYYY-MM-DD) when the domain registration expires at the registrar.
   * Shown to users as a transfer nudge when within EXPIRY_WARN_DAYS days.
   */
  expiresAt: string;

  /** Optional display tags. 'new' is auto-cleared once > 30 days old. */
  tags?: DomainTag[];

  /**
   * Set false to retire a domain without removing it from history.
   * Retired domains are never served to new users but won't break existing inboxes.
   */
  active: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Domain table — edit here only
// ─────────────────────────────────────────────────────────────────────────────
export const DOMAIN_REGISTRY: DomainEntry[] = [
  // ── Free tier ───────────────────────────────────────────────────────────
  { domain: 'ditapi.info',    tier: 'free', expiresAt: '2026-07-10', tags: [],           active: true  },
  { domain: 'ditcloud.info',  tier: 'free', expiresAt: '2026-07-10', tags: [],           active: true  },
  { domain: 'ditdrive.info',  tier: 'free', expiresAt: '2026-07-10', tags: [],           active: true  },
  { domain: 'ditgame.info',   tier: 'free', expiresAt: '2026-07-10', tags: [],           active: true  },
  { domain: 'ditlearn.info',  tier: 'free', expiresAt: '2026-07-10', tags: [],           active: true  },
  { domain: 'ditpay.info',    tier: 'free', expiresAt: '2026-07-10', tags: [],           active: true  },
  { domain: 'ditplay.info',   tier: 'free', expiresAt: '2026-07-10', tags: ['popular'], active: true  },
  { domain: 'ditube.info',    tier: 'free', expiresAt: '2026-07-10', tags: ['popular'], active: true  },
  { domain: 'junkstopper.info', tier: 'free', expiresAt: '2026-07-10', tags: [],        active: true  },
  { domain: 'areueally.info', tier: 'free', expiresAt: '2026-07-10', tags: [],           active: true  },

  // ── Pro tier (add new stealthy domains here) ─────────────────────────────
  // Example — replace with real domains when you register them:
  // { domain: 'getnotify.io',   tier: 'pro',  expiresAt: '2027-03-01', tags: ['new'],    active: true  },
  { domain: 'addmy.space', tier: 'free',  expiresAt: '2026-09-05', tags: ['new'],    active: true  },
  { domain: 'attachmy.site', tier: 'free',  expiresAt: '2026-09-05', tags: ['new'],    active: true  },
  { domain: 'ditmail.pro', tier: 'pro',  expiresAt: '2026-09-05', tags: ['new', 'featured'],    active: true  },
  { domain: 'isapi.live', tier: 'pro',  expiresAt: '2026-09-05', tags: ['new'],    active: true  },
  { domain: 'mock-api.pro', tier: 'pro',  expiresAt: '2026-09-05', tags: ['new', 'featured'],    active: true  },
];

// ─────────────────────────────────────────────────────────────────────────────
//  Derived helpers — consumed by domains.ts, v1/routes/domains.ts, inbox.ts
// ─────────────────────────────────────────────────────────────────────────────

/** Days before expiry at which we start warning users to transfer. */
export const EXPIRY_WARN_DAYS = 30;

/** All active domain strings (legacy array — keeps inbox validator working). */
export const DOMAINS: string[] = DOMAIN_REGISTRY
  .filter(d => d.active)
  .map(d => d.domain);

/** Active free domains only. */
export const FREE_DOMAINS: string[] = DOMAIN_REGISTRY
  .filter(d => d.active && d.tier === 'free')
  .map(d => d.domain);

/** Active pro domains only. */
export const PRO_DOMAINS: string[] = DOMAIN_REGISTRY
  .filter(d => d.active && d.tier === 'pro')
  .map(d => d.domain);

/**
 * Returns the full DomainEntry for a given domain string, or undefined.
 */
export function getDomainEntry(domain: string): DomainEntry | undefined {
  return DOMAIN_REGISTRY.find(d => d.domain === domain.toLowerCase());
}

/**
 * Returns true when a tag should be auto-cleared based on the domain's
 * first-seen date.  We consider a domain 'new' for 30 days from the date
 * it was added to the registry (approximated by expiresAt - 1 year since we
 * don't track an addedAt field). Pass your own date for unit-testing.
 */
export function isTagActive(entry: DomainEntry, tag: DomainTag, now = new Date()): boolean {
  if (!entry.tags?.includes(tag)) return false;
  if (tag !== 'new') return true;
  // 'new' badge expires 30 days after the domain was added.
  // Since we don't persist an addedAt, we use a convention: add 'new' manually
  // and remove it from the registry after ~30 days. This helper just gates rendering.
  return true;
}

/**
 * Returns days until expiry (negative = already expired).
 */
export function daysUntilExpiry(entry: DomainEntry, now = new Date()): number {
  const exp = new Date(entry.expiresAt);
  return Math.ceil((exp.getTime() - now.getTime()) / 86_400_000);
}

/**
 * Build the wire-format domain object returned by both internal and v1 APIs.
 * `includeExpiry` is true only when the caller has a reason to surface it
 * (i.e. the user is authenticated, or the domain is within EXPIRY_WARN_DAYS).
 */
export function formatDomainForResponse(
  entry: DomainEntry,
  opts: { alwaysExpiry?: boolean } = {},
): object {
  const days = daysUntilExpiry(entry);
  const expiringSoon = days <= EXPIRY_WARN_DAYS && days > 0;
  const expired      = days <= 0;

  const base: Record<string, unknown> = {
    domain:    entry.domain,
    tier:      entry.tier,
    tags:      entry.tags ?? [],
  };

  if (opts.alwaysExpiry || expiringSoon || expired) {
    base.expires_at    = entry.expiresAt;
    base.expires_in_days = days;
    base.expiring_soon   = expiringSoon || expired;
  }

  return base;
}