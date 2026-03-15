// api/src/v1/routes/custom-domains.ts
// ─────────────────────────────────────────────────────────────────────────────
//  Custom domain management for Growth / Enterprise API plan users.
//
//  The `customDomains` array lives on the `users` collection and is SHARED
//  between the webapp (CustomDomainManager) and this API — both read/write
//  the same field, so a domain added via the API is immediately visible in
//  the webapp dashboard and vice-versa.
//
//  Mounted at:
//    GET    /v1/custom-domains                   → list caller's custom domains
//    POST   /v1/custom-domains                   → add a new custom domain
//    DELETE /v1/custom-domains/:domain           → remove a custom domain
//    POST   /v1/custom-domains/:domain/verify    → trigger DNS verification
//
//  Plan gate: Growth + Enterprise only (CUSTOM_DOMAIN_PLANS)
// ─────────────────────────────────────────────────────────────────────────────
import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { db } from '../../config/mongo';
import { client as redis } from '../../config/redis';
import { CUSTOM_DOMAIN_PLANS } from '../api-plans';

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
//  Config
// ─────────────────────────────────────────────────────────────────────────────

const MX_RECORD  = process.env.CUSTOM_DOMAIN_MX         ?? 'mx.freecustom.email';
const TXT_PREFIX = process.env.CUSTOM_DOMAIN_TXT_PREFIX ?? 'freecustomemail-verification';

/** Maximum custom domains per user (matches webapp limit). */
const MAX_CUSTOM_DOMAINS = 10;

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** ICANN-compliant domain validation (mirrors webapp's isValidDomain). */
function isValidDomain(value: string): boolean {
  if (!value || value.length > 253) return false;
  const labels = value.split('.');
  if (labels.length < 2) return false;
  const tld = labels[labels.length - 1];
  if (!/^[a-z]{2,}$/i.test(tld)) return false;
  const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;
  return labels.every(l => LABEL_RE.test(l));
}

/**
 * Deterministic verification token — same algorithm used by the webapp's
 * domain-handler so tokens are interchangeable between both surfaces.
 */
function makeVerificationToken(domain: string, userId: string): string {
  return crypto
    .createHmac('sha256', process.env.JWT_SECRET ?? 'secret')
    .update(`${userId}:${domain}`)
    .digest('hex')
    .slice(0, 32);
}

/** Resolve MX records via Google DoH (no DNS module needed). */
async function resolveMx(domain: string): Promise<string[]> {
  const res = await fetch(
    `https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=MX`,
    { signal: AbortSignal.timeout(5_000) },
  );
  if (!res.ok) return [];
  const json = await res.json() as { Answer?: Array<{ data: string }> };
  return (json.Answer ?? [])
    .map(a => a.data.split(/\s+/).pop()!.replace(/\.$/, '').toLowerCase())
    .filter(Boolean);
}

/** Resolve TXT records via Google DoH. */
async function resolveTxt(domain: string): Promise<string[]> {
  const res = await fetch(
    `https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=TXT`,
    { signal: AbortSignal.timeout(5_000) },
  );
  if (!res.ok) return [];
  const json = await res.json() as { Answer?: Array<{ data: string }> };
  return (json.Answer ?? [])
    .map(a => a.data.replace(/^"|"$/g, ''))
    .filter(Boolean);
}

/** Full DNS check: MX + TXT. */
async function verifyDomainDns(
  domain: string,
  token: string,
): Promise<{ verified: boolean; reason?: string }> {
  const [mxRecords, txtRecords] = await Promise.all([
    resolveMx(domain),
    resolveTxt(domain),
  ]);

  const expectedMx  = MX_RECORD.toLowerCase().replace(/\.$/, '');
  const expectedTxt = `${TXT_PREFIX}=${token}`;

  const mxOk  = mxRecords.some(r => r === expectedMx);
  const txtOk = txtRecords.some(r => r === expectedTxt);

  if (!mxOk && !txtOk) return { verified: false, reason: `MX "${MX_RECORD}" and TXT "${expectedTxt}" not found.` };
  if (!mxOk)           return { verified: false, reason: `MX record pointing to "${MX_RECORD}" not found.` };
  if (!txtOk)          return { verified: false, reason: `TXT record "${expectedTxt}" not found.` };
  return { verified: true };
}

/**
 * Invalidate Redis ownership cache for all API inboxes on a given domain.
 * Call after domain removal so the next inbox ownership check hits the DB.
 */
async function bustDomainInboxCache(userId: string, domain: string, apiInboxes: string[]): Promise<void> {
  const affected = apiInboxes.filter(addr => addr.endsWith(`@${domain}`));
  await Promise.allSettled([
    ...affected.map(addr => redis.del(`user_data_cache:${addr}`)),
    ...affected.map(addr => redis.del(`inbox_owned:${userId}:${addr}`)),
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Plan-gate middleware — runs before every route in this router
// ─────────────────────────────────────────────────────────────────────────────

router.use((req: Request, res: Response, next) => {
  if (!CUSTOM_DOMAIN_PLANS.includes(req.apiUser!.plan)) {
    return res.status(403).json({
      success:     false,
      error:       'plan_required',
      message:     'Custom domains require Growth ($49/mo) or Enterprise ($149/mo) plan.',
      upgrade_url: 'https://freecustom.email/api/pricing',
    });
  }
  return next();
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /v1/custom-domains
// ─────────────────────────────────────────────────────────────────────────────

router.get('/', async (req: Request, res: Response): Promise<any> => {
  try {
    const user = await db.collection('users').findOne(
      { wyiUserId: req.apiUser!.userId },
      { projection: { customDomains: 1 } },
    );

    const list: Array<{
      domain: string; verified: boolean; mxRecord: string;
      txtRecord: string; addedAt?: string;
    }> = user?.customDomains ?? [];

    return res.json({
      success: true,
      count:   list.length,
      data:    list.map(d => ({
        domain:     d.domain,
        verified:   !!d.verified,
        mx_record:  d.mxRecord  ?? MX_RECORD,
        txt_record: d.txtRecord ?? '',
        added_at:   d.addedAt   ?? null,
      })),
    });
  } catch {
    return res.status(500).json({ success: false, error: 'server_error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /v1/custom-domains — add domain
// ─────────────────────────────────────────────────────────────────────────────

router.post('/', async (req: Request, res: Response): Promise<any> => {
  const userId = req.apiUser!.userId;
  const { domain } = req.body as { domain?: string };

  if (!domain) {
    return res.status(400).json({
      success: false,
      error:   'missing_field',
      message: '`domain` is required (e.g. "mail.yourdomain.com").',
    });
  }

  const normalized = domain.trim().toLowerCase();

  if (!isValidDomain(normalized)) {
    return res.status(400).json({
      success: false,
      error:   'invalid_domain',
      message: 'Must be a valid domain name (e.g. "mail.yourdomain.com").',
    });
  }

  try {
    const user = await db.collection('users').findOne(
      { wyiUserId: userId },
      { projection: { customDomains: 1 } },
    );

    const existing: Array<{ domain: string }> = user?.customDomains ?? [];

    // Already added — return existing entry so callers are idempotent
    const found = existing.find(d => d.domain === normalized);
    if (found) {
      return res.json({
        success: true,
        message: 'Domain already added.',
        data:    { ...found, mx_record: (found as any).mxRecord, txt_record: (found as any).txtRecord },
      });
    }

    if (existing.length >= MAX_CUSTOM_DOMAINS) {
      return res.status(400).json({
        success: false,
        error:   'limit_reached',
        message: `Maximum of ${MAX_CUSTOM_DOMAINS} custom domains reached.`,
      });
    }

    const token    = makeVerificationToken(normalized, userId);
    const txtValue = `${TXT_PREFIX}=${token}`;

    const entry = {
      domain:    normalized,
      verified:  false,
      mxRecord:  MX_RECORD,
      txtRecord: txtValue,
      addedAt:   new Date().toISOString(),
    };

    await db.collection('users').updateOne(
      { wyiUserId: userId },
      { $addToSet: { customDomains: entry } } as any,
    );

    return res.status(201).json({
      success: true,
      message: 'Domain added. Configure the DNS records below, then call the verify endpoint.',
      data: {
        domain:      normalized,
        verified:    false,
        mx_record:   MX_RECORD,
        txt_record:  txtValue,
        added_at:    entry.addedAt,
        dns_records: [
          { type: 'MX',  hostname: '@', value: MX_RECORD, priority: '10', ttl: 'Auto' },
          { type: 'TXT', hostname: '@', value: txtValue,                   ttl: 'Auto' },
        ],
        next_step: `POST /v1/custom-domains/${normalized}/verify`,
      },
    });
  } catch {
    return res.status(500).json({ success: false, error: 'server_error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /v1/custom-domains/:domain/verify
// ─────────────────────────────────────────────────────────────────────────────

router.post('/:domain/verify', async (req: Request, res: Response): Promise<any> => {
  const userId = req.apiUser!.userId;
  const domain = req.params.domain.toLowerCase();

  try {
    const user = await db.collection('users').findOne(
      { wyiUserId: userId },
      { projection: { customDomains: 1 } },
    );

    const entry = (user?.customDomains ?? []).find(
      (d: { domain: string }) => d.domain === domain,
    );

    if (!entry) {
      return res.status(404).json({
        success: false,
        error:   'domain_not_found',
        message: `"${domain}" not found. Add it first via POST /v1/custom-domains.`,
      });
    }

    if (entry.verified) {
      return res.json({ success: true, verified: true, message: 'Domain is already verified.' });
    }

    const token  = makeVerificationToken(domain, userId);
    const result = await verifyDomainDns(domain, token);

    if (result.verified) {
      await db.collection('users').updateOne(
        { wyiUserId: userId, 'customDomains.domain': domain },
        { $set: { 'customDomains.$.verified': true } },
      );

      return res.json({
        success:  true,
        verified: true,
        message:  `Domain "${domain}" verified successfully. You can now register inboxes at @${domain}.`,
        data: {
          domain,
          verified:   true,
          mx_record:  entry.mxRecord  ?? MX_RECORD,
          txt_record: entry.txtRecord ?? '',
        },
      });
    }

    return res.status(422).json({
      success:  false,
      verified: false,
      error:    'verification_failed',
      message:  result.reason ?? 'DNS records not yet propagated. Try again in a few minutes.',
      hint:     'DNS propagation can take up to 48 hours.',
      dns_records_needed: [
        { type: 'MX',  hostname: '@', value: MX_RECORD,        priority: '10' },
        { type: 'TXT', hostname: '@', value: entry.txtRecord ?? '' },
      ],
    });
  } catch (err) {
    console.error('[custom-domains] verify error:', err);
    return res.status(500).json({ success: false, error: 'server_error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  DELETE /v1/custom-domains/:domain
// ─────────────────────────────────────────────────────────────────────────────

router.delete('/:domain', async (req: Request, res: Response): Promise<any> => {
  const userId = req.apiUser!.userId;
  const domain = req.params.domain.toLowerCase();

  try {
    const user = await db.collection('users').findOne(
      { wyiUserId: userId },
      { projection: { customDomains: 1, apiInboxes: 1 } },
    );

    const exists = (user?.customDomains ?? []).some(
      (d: { domain: string }) => d.domain === domain,
    );

    if (!exists) {
      return res.status(404).json({
        success: false,
        error:   'domain_not_found',
        message: `Domain "${domain}" not found in your account.`,
      });
    }

    await db.collection('users').updateOne(
      { wyiUserId: userId },
      { $pull: { customDomains: { domain } } } as any,
    );

    // Remove API inboxes that used this domain
    const apiInboxes: string[] = user?.apiInboxes ?? [];
    const toRemove = apiInboxes.filter(addr => addr.endsWith(`@${domain}`));

    if (toRemove.length) {
      await db.collection('users').updateOne(
        { wyiUserId: userId },
        { $pullAll: { apiInboxes: toRemove } } as any,
      );
      await bustDomainInboxCache(userId, domain, apiInboxes);
    }

    return res.json({
      success:         true,
      message:         `Domain "${domain}" removed.`,
      inboxes_removed: toRemove,
    });
  } catch {
    return res.status(500).json({ success: false, error: 'server_error' });
  }
});

export default router;