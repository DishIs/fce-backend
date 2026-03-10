// api-custom-domains-handler.ts
// ─────────────────────────────────────────────────────────────────────────────
//  Internal Express routes for custom domain management.
//  Accepts ?wyiUserId= + x-internal-api-key (enforced in server.ts).
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
import { promises as dns, MxRecord } from 'dns';
import { db, IUser } from './mongo';
import { client as redis } from './redis';
import { CUSTOM_DOMAIN_PLANS, ApiPlanName } from './v1/api-plans';

// ─────────────────────────────────────────────────────────────────────────────
//  Config
// ─────────────────────────────────────────────────────────────────────────────

const MX_RECORD  = process.env.CUSTOM_DOMAIN_MX         ?? 'mx.freecustom.email';
const TXT_PREFIX = process.env.CUSTOM_DOMAIN_TXT_PREFIX ?? 'freecustomemail-verification';
const MAX_DOMAINS = 10;

// ─────────────────────────────────────────────────────────────────────────────
//  getUser — canonical lookup (primary or linked provider ID)
// ─────────────────────────────────────────────────────────────────────────────

async function getUser(userId: string): Promise<IUser | null> {
  return await db.collection<IUser>('users').findOne({
    $or: [
      { wyiUserId: userId },
      { linkedProviderIds: userId },
    ],
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Domain validation
// ─────────────────────────────────────────────────────────────────────────────

function isValidDomain(v: string): boolean {
  if (!v || v.length > 253) return false;
  const labels = v.split('.');
  if (labels.length < 2) return false;
  if (!/^[a-z]{2,}$/i.test(labels[labels.length - 1])) return false;
  return labels.every(l => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i.test(l));
}

// ─────────────────────────────────────────────────────────────────────────────
//  Verification token — same deterministic formula as v1/routes/custom-domains
// ─────────────────────────────────────────────────────────────────────────────

function makeToken(domain: string, userId: string): string {
  return crypto
    .createHmac('sha256', process.env.JWT_SECRET ?? 'secret')
    .update(`${userId}:${domain}`)
    .digest('hex')
    .slice(0, 32);
}

// ─────────────────────────────────────────────────────────────────────────────
//  DNS verification — mirrors domain-handler.ts (Node dns module, not DoH)
// ─────────────────────────────────────────────────────────────────────────────

async function checkDns(
  domain: string,
  expectedTxtToken: string,
  expectedMxHost: string,
): Promise<{ ok: boolean; reason?: string }> {
  const expectedTxtValue = `${TXT_PREFIX}=${expectedTxtToken}`;

  // ── TXT ──────────────────────────────────────────────────────────────────
  let txtRecords: string[][] = [];
  try {
    txtRecords = await dns.resolveTxt(domain);
  } catch (err: any) {
    if (err.code === 'ENODATA' || err.code === 'ENOTFOUND') {
      return { ok: false, reason: 'TXT record not found. It may not have propagated yet.' };
    }
    throw err;
  }

  const isTxtVerified = txtRecords.flat().includes(expectedTxtValue);
  if (!isTxtVerified) {
    return {
      ok: false,
      reason: `TXT record "${expectedTxtValue}" not found. Please double-check the value at your registrar.`,
    };
  }

  // ── MX ───────────────────────────────────────────────────────────────────
  let mxRecords: MxRecord[] = [];
  try {
    mxRecords = await dns.resolveMx(domain);
  } catch (err: any) {
    if (err.code === 'ENODATA' || err.code === 'ENOTFOUND') {
      return {
        ok: false,
        reason: `MX record not found. Please add an MX record pointing to ${expectedMxHost}.`,
      };
    }
    throw err;
  }

  const isMxValid = mxRecords.some(
    mx =>
      mx.exchange.toLowerCase() === expectedMxHost.toLowerCase() ||
      mx.exchange.toLowerCase().endsWith('.freecustom.email'),
  );

  if (!isMxValid) {
    return {
      ok: false,
      reason: `MX record must point to ${expectedMxHost}. Current MX records: ${mxRecords.map(m => m.exchange).join(', ')}`,
    };
  }

  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Plan gate + user resolution
//  Returns the resolved IUser (with canonical wyiUserId) or null if the
//  response has already been sent.
// ─────────────────────────────────────────────────────────────────────────────

async function resolveAndGate(req: Request, res: Response): Promise<IUser | null> {
  const rawId = req.query.wyiUserId as string | undefined;
  if (!rawId) {
    res.status(400).json({ success: false, error: 'missing_param', message: 'wyiUserId required.' });
    return null;
  }

  const user = await getUser(rawId);
  if (!user) {
    res.status(404).json({ success: false, error: 'user_not_found' });
    return null;
  }

  const plan: ApiPlanName = (user as any).apiPlan ?? 'free';
  if (!CUSTOM_DOMAIN_PLANS.includes(plan)) {
    res.status(403).json({
      success:     false,
      error:       'plan_required',
      message:     'Custom domains via the API require Growth ($49/mo) or Enterprise ($149/mo) plan.',
      upgrade_url: 'https://freecustom.email/api/pricing',
    });
    return null;
  }

  return user;
}

// ─────────────────────────────────────────────────────────────────────────────
//  GET /user/api-custom-domains
// ─────────────────────────────────────────────────────────────────────────────

export async function listApiCustomDomains(req: Request, res: Response): Promise<void> {
  const user = await resolveAndGate(req, res);
  if (!user) return;

  try {
    const full = await db.collection('users').findOne(
      { _id: user._id },
      { projection: { customDomains: 1 } },
    );

    const list = ((full?.customDomains ?? []) as any[]).map(d => ({
      domain:     d.domain,
      verified:   !!d.verified,
      mx_record:  d.mxRecord  ?? MX_RECORD,
      txt_record: d.txtRecord ?? '',
      added_at:   d.addedAt   ?? null,
    }));

    res.json({ success: true, count: list.length, data: list });
  } catch {
    res.status(500).json({ success: false, error: 'server_error' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  POST /user/api-custom-domains
// ─────────────────────────────────────────────────────────────────────────────

export async function addApiCustomDomain(req: Request, res: Response): Promise<void> {
  const user = await resolveAndGate(req, res);
  if (!user) return;

  const { domain } = req.body as { domain?: string };
  if (!domain) {
    res.status(400).json({ success: false, error: 'missing_field', message: '`domain` required.' });
    return;
  }

  const norm = domain.trim().toLowerCase();
  if (!isValidDomain(norm)) {
    res.status(400).json({ success: false, error: 'invalid_domain', message: 'Invalid domain name.' });
    return;
  }

  try {
    const full = await db.collection('users').findOne(
      { _id: user._id },
      { projection: { customDomains: 1 } },
    );
    const existing: any[] = full?.customDomains ?? [];

    // Idempotent — return existing entry unchanged
    const found = existing.find(d => d.domain === norm);
    if (found) {
      res.json({
        success: true,
        message: 'Already added.',
        data: {
          domain:     found.domain,
          verified:   !!found.verified,
          mx_record:  found.mxRecord  ?? MX_RECORD,
          txt_record: found.txtRecord ?? '',
          added_at:   found.addedAt   ?? null,
        },
      });
      return;
    }

    if (existing.length >= MAX_DOMAINS) {
      res.status(400).json({ success: false, error: 'limit_reached', message: `Max ${MAX_DOMAINS} custom domains.` });
      return;
    }

    const token    = makeToken(norm, user.wyiUserId);
    const txtValue = `${TXT_PREFIX}=${token}`;
    const entry    = {
      domain:    norm,
      verified:  false,
      mxRecord:  MX_RECORD,
      txtRecord: txtValue,
      addedAt:   new Date().toISOString(),
    };

    await db.collection('users').updateOne(
      { _id: user._id },
      { $addToSet: { customDomains: entry } } as any,
    );

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
          { type: 'MX',  hostname: '@', value: MX_RECORD, priority: '10', ttl: 'Auto' },
          { type: 'TXT', hostname: '@', value: txtValue,                   ttl: 'Auto' },
        ],
        next_step: `POST /v1/custom-domains/${norm}/verify`,
      },
    });
  } catch {
    res.status(500).json({ success: false, error: 'server_error' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  POST /user/api-custom-domains/:domain/verify
// ─────────────────────────────────────────────────────────────────────────────

export async function verifyApiCustomDomain(req: Request, res: Response): Promise<void> {
  const user = await resolveAndGate(req, res);
  if (!user) return;

  const domain = (req.params.domain ?? '').toLowerCase();

  try {
    // Use positional projection to pull just this domain's subdocument
    const full = await db.collection('users').findOne(
      { _id: user._id, 'customDomains.domain': domain },
      { projection: { 'customDomains.$': 1 } },
    );
    const entry = full?.customDomains?.[0] as any | undefined;

    if (!entry) {
      res.status(404).json({
        success: false,
        error:   'domain_not_found',
        message: `Domain "${domain}" not found. Add it first via POST /v1/custom-domains.`,
      });
      return;
    }

    if (entry.verified) {
      res.json({ success: true, verified: true, message: 'Domain is already verified.' });
      return;
    }

    const token  = makeToken(domain, user.wyiUserId);
    const result = await checkDns(domain, token, entry.mxRecord ?? MX_RECORD);

    if (!result.ok) {
      res.status(422).json({
        success:  false,
        verified: false,
        error:    'verification_failed',
        message:  result.reason,
        hint:     'DNS propagation can take up to 48 hours.',
        dns_records_needed: [
          { type: 'MX',  hostname: '@', value: entry.mxRecord ?? MX_RECORD, priority: '10' },
          { type: 'TXT', hostname: '@', value: entry.txtRecord ?? '' },
        ],
      });
      return;
    }

    // Mark verified on this user
    await db.collection('users').updateOne(
      { _id: user._id, 'customDomains.domain': domain },
      { $set: { 'customDomains.$.verified': true } },
    );

    // Remove domain from every other user (mirrors verifyDomainHandler)
    await db.collection('users').updateMany(
      { _id: { $ne: user._id } },
      { $pull: { customDomains: { domain } } } as any,
    );

    // Add to Haraka's Redis set so it starts accepting mail immediately
    await redis.sAdd('verified_custom_domains', domain);

    res.json({
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
  } catch (err: any) {
    console.error('[api-custom-domains] verify error:', err);
    res.status(500).json({ success: false, error: 'server_error', message: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  DELETE /user/api-custom-domains/:domain
// ─────────────────────────────────────────────────────────────────────────────

export async function deleteApiCustomDomain(req: Request, res: Response): Promise<void> {
  const user = await resolveAndGate(req, res);
  if (!user) return;

  const domain = (req.params.domain ?? '').toLowerCase();

  try {
    const full = await db.collection('users').findOne(
      { _id: user._id },
      { projection: { customDomains: 1, apiInboxes: 1 } },
    );

    const exists = ((full?.customDomains ?? []) as any[]).some(d => d.domain === domain);
    if (!exists) {
      res.status(404).json({
        success: false,
        error:   'domain_not_found',
        message: `Domain "${domain}" not found in your account.`,
      });
      return;
    }

    await db.collection('users').updateOne(
      { _id: user._id },
      { $pull: { customDomains: { domain } } } as any,
    );

    // Remove from Haraka's Redis set
    await redis.sRem('verified_custom_domains', domain);

    // Unregister any API inboxes that used this domain
    const apiInboxes: string[] = (full?.apiInboxes ?? []) as string[];
    const toRemove = apiInboxes.filter(a => a.endsWith(`@${domain}`));

    if (toRemove.length) {
      await db.collection('users').updateOne(
        { _id: user._id },
        { $pullAll: { apiInboxes: toRemove } } as any,
      );
      await Promise.allSettled([
        ...toRemove.map(a => redis.del(`user_data_cache:${a}`)),
        ...toRemove.map(a => redis.del(`inbox_owned:${user.wyiUserId}:${a}`)),
      ]);
    }

    res.json({
      success:         true,
      message:         `"${domain}" removed.`,
      inboxes_removed: toRemove,
    });
  } catch {
    res.status(500).json({ success: false, error: 'server_error' });
  }
}