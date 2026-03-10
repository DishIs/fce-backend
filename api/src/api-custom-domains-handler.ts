// api-custom-domains-handler.ts
// ─────────────────────────────────────────────────────────────────────────────
//  Internal Express routes that mirror the v1/routes/custom-domains logic but
//  accept `?wyiUserId=` instead of an API key — these are only reachable with
//  the INTERNAL_API_KEY header (enforced in server.ts internalApiAuth).
//
//  The Next.js frontend calls these via the /api/user/api-custom-domains proxy
//  routes so the browser never touches the v1 API key system directly.
//
//  Mounted in server.ts at:
//    GET    /user/api-custom-domains
//    POST   /user/api-custom-domains
//    DELETE /user/api-custom-domains/:domain
//    POST   /user/api-custom-domains/:domain/verify
//
//  Plan gate: user must have apiPlan = 'growth' | 'enterprise'
// ─────────────────────────────────────────────────────────────────────────────
import { Request, Response } from 'express';
import crypto from 'crypto';
import { db } from './mongo';
import { client as redis } from './redis';
import { CUSTOM_DOMAIN_PLANS, ApiPlanName } from './v1/api-plans';

// ─────────────────────────────────────────────────────────────────────────────
//  Config
// ─────────────────────────────────────────────────────────────────────────────

const MX_RECORD  = process.env.CUSTOM_DOMAIN_MX         ?? 'mx.freecustom.email';
const TXT_PREFIX = process.env.CUSTOM_DOMAIN_TXT_PREFIX ?? 'freecustomemail-verification';
const MAX_DOMAINS = 10;

// ─────────────────────────────────────────────────────────────────────────────
//  Shared helpers (same as v1/routes/custom-domains.ts)
// ─────────────────────────────────────────────────────────────────────────────

function isValidDomain(v: string): boolean {
  if (!v || v.length > 253) return false;
  const labels = v.split('.');
  if (labels.length < 2) return false;
  if (!/^[a-z]{2,}$/i.test(labels[labels.length - 1])) return false;
  return labels.every(l => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i.test(l));
}

function makeToken(domain: string, userId: string): string {
  return crypto
    .createHmac('sha256', process.env.JWT_SECRET ?? 'secret')
    .update(`${userId}:${domain}`)
    .digest('hex')
    .slice(0, 32);
}

async function resolveMx(domain: string): Promise<string[]> {
  const res = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=MX`, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) return [];
  const json = await res.json() as { Answer?: Array<{ data: string }> };
  return (json.Answer ?? []).map(a => a.data.split(/\s+/).pop()!.replace(/\.$/, '').toLowerCase()).filter(Boolean);
}

async function resolveTxt(domain: string): Promise<string[]> {
  const res = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=TXT`, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) return [];
  const json = await res.json() as { Answer?: Array<{ data: string }> };
  return (json.Answer ?? []).map(a => a.data.replace(/^"|"$/g, '')).filter(Boolean);
}

async function checkDns(domain: string, token: string): Promise<{ ok: boolean; reason?: string }> {
  const [mxRecs, txtRecs] = await Promise.all([resolveMx(domain), resolveTxt(domain)]);
  const mxOk  = mxRecs.some(r => r === MX_RECORD.toLowerCase().replace(/\.$/, ''));
  const txtOk = txtRecs.some(r => r === `${TXT_PREFIX}=${token}`);
  if (!mxOk && !txtOk) return { ok: false, reason: `MX "${MX_RECORD}" and TXT "${TXT_PREFIX}=${token}" not found.` };
  if (!mxOk)           return { ok: false, reason: `MX record pointing to "${MX_RECORD}" not found.` };
  if (!txtOk)          return { ok: false, reason: `TXT record "${TXT_PREFIX}=${token}" not found.` };
  return { ok: true };
}

/** Resolve userId from ?wyiUserId query param, check plan, return userId or null */
async function resolveAndGate(req: Request, res: Response): Promise<string | null> {
  const userId = req.query.wyiUserId as string | undefined;
  if (!userId) {
    res.status(400).json({ success: false, error: 'missing_param', message: 'wyiUserId required.' });
    return null;
  }
  const user = await db.collection('users').findOne({ wyiUserId: userId }, { projection: { apiPlan: 1 } });
  if (!user) {
    res.status(404).json({ success: false, error: 'user_not_found' });
    return null;
  }
  const plan: ApiPlanName = user.apiPlan ?? 'free';
  if (!CUSTOM_DOMAIN_PLANS.includes(plan)) {
    res.status(403).json({
      success: false,
      error:   'plan_required',
      message: 'Custom domains via the API require Growth ($49/mo) or Enterprise ($149/mo) plan.',
      upgrade_url: 'https://freecustom.email/api/pricing',
    });
    return null;
  }
  return userId;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Handlers
// ─────────────────────────────────────────────────────────────────────────────

export async function listApiCustomDomains(req: Request, res: Response): Promise<void> {
  const userId = await resolveAndGate(req, res);
  if (!userId) return;
  try {
    const user = await db.collection('users').findOne({ wyiUserId: userId }, { projection: { customDomains: 1 } });
    const list = (user?.customDomains ?? []).map((d: any) => ({
      domain:    d.domain,
      verified:  !!d.verified,
      mx_record:  d.mxRecord  ?? MX_RECORD,
      txt_record: d.txtRecord ?? '',
      added_at:  d.addedAt ?? null,
    }));
    res.json({ success: true, count: list.length, data: list });
  } catch { res.status(500).json({ success: false, error: 'server_error' }); }
}

export async function addApiCustomDomain(req: Request, res: Response): Promise<void> {
  const userId = await resolveAndGate(req, res);
  if (!userId) return;

  const { domain } = req.body as { domain?: string };
  if (!domain) { res.status(400).json({ success: false, error: 'missing_field', message: '`domain` required.' }); return; }

  const norm = domain.trim().toLowerCase();
  if (!isValidDomain(norm)) { res.status(400).json({ success: false, error: 'invalid_domain', message: 'Invalid domain name.' }); return; }

  try {
    const user = await db.collection('users').findOne({ wyiUserId: userId }, { projection: { customDomains: 1 } });
    const existing: Array<{ domain: string }> = user?.customDomains ?? [];

    const found = existing.find(d => d.domain === norm);
    if (found) { res.json({ success: true, message: 'Already added.', data: { ...found, mx_record: (found as any).mxRecord, txt_record: (found as any).txtRecord } }); return; }

    if (existing.length >= MAX_DOMAINS) { res.status(400).json({ success: false, error: 'limit_reached', message: `Max ${MAX_DOMAINS} custom domains.` }); return; }

    const token    = makeToken(norm, userId);
    const txtValue = `${TXT_PREFIX}=${token}`;
    const entry    = { domain: norm, verified: false, mxRecord: MX_RECORD, txtRecord: txtValue, addedAt: new Date().toISOString() };

    await db.collection('users').updateOne({ wyiUserId: userId }, { $addToSet: { customDomains: entry } } as any);

    res.status(201).json({
      success: true,
      message: 'Domain added. Configure DNS records, then call verify.',
      data: {
        domain:     norm,
        verified:   false,
        mx_record:  MX_RECORD,
        txt_record: txtValue,
        added_at:   entry.addedAt,
        dns_records: [
          { type: 'MX',  hostname: '@', value: MX_RECORD,  priority: '10', ttl: 'Auto' },
          { type: 'TXT', hostname: '@', value: txtValue,                    ttl: 'Auto' },
        ],
      },
    });
  } catch { res.status(500).json({ success: false, error: 'server_error' }); }
}

export async function verifyApiCustomDomain(req: Request, res: Response): Promise<void> {
  const userId = await resolveAndGate(req, res);
  if (!userId) return;

  const domain = (req.params.domain ?? '').toLowerCase();
  try {
    const user  = await db.collection('users').findOne({ wyiUserId: userId }, { projection: { customDomains: 1 } });
    const entry = (user?.customDomains ?? []).find((d: any) => d.domain === domain);

    if (!entry) { res.status(404).json({ success: false, error: 'domain_not_found' }); return; }
    if (entry.verified) { res.json({ success: true, verified: true, message: 'Already verified.' }); return; }

    const token  = makeToken(domain, userId);
    const result = await checkDns(domain, token);

    if (result.ok) {
      await db.collection('users').updateOne(
        { wyiUserId: userId, 'customDomains.domain': domain },
        { $set: { 'customDomains.$.verified': true } },
      );
      res.json({ success: true, verified: true, message: `"${domain}" verified.`, data: { domain, verified: true, mx_record: entry.mxRecord, txt_record: entry.txtRecord } });
    } else {
      res.status(422).json({ success: false, verified: false, error: 'verification_failed', message: result.reason });
    }
  } catch (err) {
    console.error('[api-custom-domains] verify error:', err);
    res.status(500).json({ success: false, error: 'server_error' });
  }
}

export async function deleteApiCustomDomain(req: Request, res: Response): Promise<void> {
  const userId = await resolveAndGate(req, res);
  if (!userId) return;

  const domain = (req.params.domain ?? '').toLowerCase();
  try {
    const user = await db.collection('users').findOne({ wyiUserId: userId }, { projection: { customDomains: 1, apiInboxes: 1 } });
    if (!(user?.customDomains ?? []).some((d: any) => d.domain === domain)) {
      res.status(404).json({ success: false, error: 'domain_not_found' });
      return;
    }

    await db.collection('users').updateOne({ wyiUserId: userId }, { $pull: { customDomains: { domain } } } as any);

    const toRemove: string[] = (user?.apiInboxes ?? []).filter((a: string) => a.endsWith(`@${domain}`));
    if (toRemove.length) {
      await db.collection('users').updateOne({ wyiUserId: userId }, { $pullAll: { apiInboxes: toRemove } } as any);
      await Promise.allSettled([
        ...toRemove.map((a: string) => redis.del(`user_data_cache:${a}`)),
        ...toRemove.map((a: string) => redis.del(`inbox_owned:${userId}:${a}`)),
      ]);
    }

    res.json({ success: true, message: `"${domain}" removed.`, inboxes_removed: toRemove });
  } catch { res.status(500).json({ success: false, error: 'server_error' }); }
}