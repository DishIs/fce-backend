// v1/routes/inbox.ts
// ─────────────────────────────────────────────────────────────────────────────
//  All inbox operations for external API users.
//
//  Mounted at:  GET    /v1/inboxes
//               POST   /v1/inboxes
//               DELETE /v1/inboxes/:inbox
//               GET    /v1/inboxes/:inbox/messages
//               GET    /v1/inboxes/:inbox/messages/:id
//               DELETE /v1/inboxes/:inbox/messages/:id
//               GET    /v1/inboxes/:inbox/otp
// ─────────────────────────────────────────────────────────────────────────────
import { Router, Request, Response } from 'express';
import { getInbox, getMessage, deleteMessageById } from '../../mailbox';
import { db } from '../../mongo';
import { client as redis } from '../../redis';
import { getDomainEntry } from '../../domain-registry';            // ← from registry
import {
  API_PLANS,
  ApiPlanName,
  apiPlanToInternalPlan,
  OTP_PLANS,
  CUSTOM_DOMAIN_PLANS,
} from '../api-plans';

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * True when the caller's API plan can use pro-tier platform domains.
 * Maps 1:1 with CUSTOM_DOMAIN_PLANS so growth/enterprise get both custom
 * domains AND pro platform domains.
 */
function canUseProDomains(plan: ApiPlanName): boolean {
  return CUSTOM_DOMAIN_PLANS.includes(plan); // growth + enterprise
}

/**
 * Confirm that the given inbox is registered under this API user.
 * Redis-cached for 30s to avoid a DB hit on every message fetch.
 */
async function assertOwned(userId: string, inbox: string): Promise<boolean> {
  const cacheKey = `inbox_owned:${userId}:${inbox}`;
  try {
    const hit = await redis.get(cacheKey);
    if (hit !== null) return hit === '1';
  } catch (_) { /* cache miss — fall through */ }

  const user = await db.collection('users').findOne({
    wyiUserId: userId,
    apiInboxes: inbox.toLowerCase(),
  });
  const owned = !!user;
  redis.set(cacheKey, owned ? '1' : '0', { EX: 30 }).catch(() => {});
  return owned;
}

/** Strip or tease OTP/verificationLink fields based on the caller's plan */
function sanitizeMessage(msg: any, plan: ApiPlanName): any {
  if (!OTP_PLANS.includes(plan)) {
    return {
      ...msg,
      otp: msg.otp ? '__DETECTED__' : null,
      verificationLink: msg.verificationLink ? '__DETECTED__' : null,
      _upgrade_hint: msg.otp || msg.verificationLink
        ? 'Upgrade to Developer plan to unlock OTP extraction.'
        : undefined,
    };
  }
  return msg;
}

/** Filter/strip attachments based on the plan's size limit */
function sanitizeAttachments(msg: any, plan: ApiPlanName): any {
  const cfg = API_PLANS[plan];
  if (!cfg.features.attachments) {
    const { attachments: _a, ...rest } = msg;
    return {
      ...rest,
      _attachments_blocked: msg.attachments?.length
        ? 'Attachments require Startup plan or above.'
        : undefined,
    };
  }
  const limitBytes = cfg.features.maxAttachmentSizeMb * 1024 * 1024;
  return {
    ...msg,
    attachments: (msg.attachments || []).filter((a: any) => a.size <= limitBytes),
    _attachments_truncated: (msg.attachments || []).some((a: any) => a.size > limitBytes),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /v1/inboxes — list registered inboxes
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', async (req: Request, res: Response): Promise<any> => {
  try {
    const user = await db.collection('users').findOne(
      { wyiUserId: req.apiUser!.userId },
      { projection: { apiInboxes: 1, inboxes: 1 } },
    );
    const apiInboxesList = user?.apiInboxes ?? [];
    const appInboxesList = Array.isArray(user?.inboxes)
      ? user.inboxes.map((i: any) => String(i).toLowerCase())
      : [];
    return res.json({
      success:         true,
      data:            apiInboxesList,
      count:           apiInboxesList.length,
      api_inboxes:     apiInboxesList,
      api_inbox_count: apiInboxesList.length,
      app_inboxes:     appInboxesList,
      app_inbox_count: appInboxesList.length,
    });
  } catch {
    return res.status(500).json({ success: false, error: 'server_error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/inboxes — register an inbox
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', async (req: Request, res: Response): Promise<any> => {
  const { inbox } = req.body;
  const apiUser   = req.apiUser!;

  if (!inbox) {
    return res.status(400).json({
      success: false,
      error:   'missing_field',
      message: '`inbox` (full email address) is required.',
    });
  }

  const normalized = inbox.trim().toLowerCase();

  if (!/^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/.test(normalized)) {
    return res.status(400).json({
      success: false,
      error:   'invalid_inbox',
      message: 'Must be a valid email address, e.g. "mybox@ditube.info".',
    });
  }

  const domain = normalized.split('@')[1];

  // ── Domain tier gate ──────────────────────────────────────────────────────
  const registryEntry = getDomainEntry(domain);

  if (registryEntry) {
    // It's a platform domain — enforce tier.
    if (registryEntry.tier === 'pro' && !canUseProDomains(apiUser.plan)) {
      return res.status(403).json({
        success:     false,
        error:       'plan_restriction',
        message:     `@${domain} is a Pro-tier domain and requires Growth plan or above. Use a free domain (e.g. @ditube.info) or upgrade.`,
        upgrade_url: 'https://freecustom.email/api/pricing',
      });
    }
  } else {
    // Not a platform domain — must be a verified custom domain on Growth+.
    if (!CUSTOM_DOMAIN_PLANS.includes(apiUser.plan)) {
      return res.status(403).json({
        success:                  false,
        error:                    'domain_not_allowed',
        message:                  `Domain "${domain}" is not supported. Use an inbox at one of our provided domains (e.g. something@ditube.info). Custom domains require Growth plan or above.`,
        provided_domains_example: 'ditube.info',
        upgrade_url:              'https://freecustom.email/api/pricing',
      });
    }

    // Growth+ user — domain must be verified in their account.
    const userDoc = await db.collection('users').findOne(
      { wyiUserId: apiUser.userId },
      { projection: { customDomains: 1 } },
    );
    const isVerified = (userDoc?.customDomains ?? []).some(
      (d: { domain: string; verified?: boolean }) =>
        d.domain.toLowerCase() === domain && d.verified === true,
    );

    if (!isVerified) {
      return res.status(403).json({
        success: false,
        error:   'domain_not_verified',
        message: `Domain "${domain}" is not verified. Add and verify it in your dashboard first.`,
      });
    }
  }

  // ── Register ──────────────────────────────────────────────────────────────
  const isProvidedDomain = !!registryEntry;

  try {
    const user = await db.collection('users').findOne({ wyiUserId: apiUser.userId });
    if (!user) return res.status(404).json({ success: false, error: 'user_not_found' });

    const already = (user.apiInboxes ?? []).includes(normalized);
    if (already) {
      return res.json({ success: true, message: 'Inbox already registered.', inbox: normalized });
    }

    await db.collection('users').updateOne(
      { wyiUserId: apiUser.userId },
      { $addToSet: { apiInboxes: normalized } },
    );

    const internalPlan = apiPlanToInternalPlan(apiUser.plan);
    await redis.set(
      `user_data_cache:${normalized}`,
      JSON.stringify({ plan: internalPlan, userId: user._id, isVerified: !isProvidedDomain }),
      { EX: 3600 },
    );

    await redis.del(`inbox_owned:${apiUser.userId}:${normalized}`).catch(() => {});

    return res.status(201).json({ success: true, message: 'Inbox registered.', inbox: normalized });
  } catch {
    return res.status(500).json({ success: false, error: 'server_error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /v1/inboxes/:inbox — unregister an inbox
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/:inbox', async (req: Request, res: Response): Promise<any> => {
  const inbox  = req.params.inbox.toLowerCase();
  const userId = req.apiUser!.userId;
  try {
    await db.collection('users').updateOne(
      { wyiUserId: userId },
      { $pull: { apiInboxes: inbox } as any },
    );
    await Promise.all([
      redis.del(`user_data_cache:${inbox}`),
      redis.del(`inbox_owned:${userId}:${inbox}`),
    ]);
    return res.json({ success: true, message: 'Inbox unregistered.' });
  } catch {
    return res.status(500).json({ success: false, error: 'server_error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /v1/inboxes/:inbox/messages — list messages
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:inbox/messages', async (req: Request, res: Response): Promise<any> => {
  const inbox   = req.params.inbox.toLowerCase();
  const apiUser = req.apiUser!;

  if (!(await assertOwned(apiUser.userId, inbox))) {
    return res.status(403).json({
      success: false,
      error:   'inbox_not_owned',
      message: 'Register this inbox first via POST /v1/inboxes.',
    });
  }

  try {
    const internalPlan = apiPlanToInternalPlan(apiUser.plan);
    const raw  = (await getInbox(inbox, internalPlan)) as any[];
    const data = raw.map(msg => sanitizeMessage(msg, apiUser.plan));
    return res.json({ success: true, data, count: data.length });
  } catch {
    return res.status(500).json({ success: false, error: 'server_error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /v1/inboxes/:inbox/messages/:id — single message
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:inbox/messages/:id', async (req: Request, res: Response): Promise<any> => {
  const { inbox, id } = req.params;
  const normalizedInbox = inbox.toLowerCase();
  const apiUser = req.apiUser!;

  if (!(await assertOwned(apiUser.userId, normalizedInbox))) {
    return res.status(403).json({
      success: false,
      error:   'inbox_not_owned',
      message: 'Register this inbox first via POST /v1/inboxes.',
    });
  }

  try {
    const internalPlan = apiPlanToInternalPlan(apiUser.plan);
    const msg = await getMessage(normalizedInbox, id, internalPlan);

    if (!msg) {
      return res.status(404).json({ success: false, error: 'not_found', message: 'Message not found.' });
    }

    const sanitized = sanitizeAttachments(sanitizeMessage(msg, apiUser.plan), apiUser.plan);
    return res.json({ success: true, data: sanitized });
  } catch {
    return res.status(500).json({ success: false, error: 'server_error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /v1/inboxes/:inbox/otp — extract the latest OTP (Developer+ only)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:inbox/otp', async (req: Request, res: Response): Promise<any> => {
  const inbox   = req.params.inbox.toLowerCase();
  const apiUser = req.apiUser!;

  if (!OTP_PLANS.includes(apiUser.plan)) {
    return res.status(403).json({
      success:     false,
      error:       'plan_required',
      message:     'OTP extraction requires Developer plan ($7/mo) or above.',
      upgrade_url: 'https://freecustom.email/api/pricing',
    });
  }

  if (!(await assertOwned(apiUser.userId, inbox))) {
    return res.status(403).json({
      success: false,
      error:   'inbox_not_owned',
      message: 'Register this inbox first via POST /v1/inboxes.',
    });
  }

  try {
    const internalPlan = apiPlanToInternalPlan(apiUser.plan);
    const messages = (await getInbox(inbox, internalPlan)) as any[];

    const withOtp = messages
      .filter(m => m.otp && !['__DETECTED__', '__UPGRADE_REQUIRED__'].includes(m.otp))
      .sort((a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime());

    if (!withOtp.length) {
      return res.json({ success: true, otp: null, message: 'No OTP found in recent messages.' });
    }

    const latest = withOtp[0];
    return res.json({
      success:           true,
      otp:               latest.otp,
      email_id:          latest.id,
      from:              latest.from,
      subject:           latest.subject,
      timestamp:         new Date(latest.date).getTime(),
      verification_link: latest.verificationLink ?? null,
    });
  } catch {
    return res.status(500).json({ success: false, error: 'server_error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /v1/inboxes/:inbox/messages/:id — delete a message
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/:inbox/messages/:id', async (req: Request, res: Response): Promise<any> => {
  const { inbox, id } = req.params;
  const normalizedInbox = inbox.toLowerCase();
  const apiUser = req.apiUser!;

  if (!(await assertOwned(apiUser.userId, normalizedInbox))) {
    return res.status(403).json({ success: false, error: 'inbox_not_owned' });
  }

  try {
    const internalPlan = apiPlanToInternalPlan(apiUser.plan);
    const deleted = await deleteMessageById(normalizedInbox, id, internalPlan);
    return res.json({
      success: deleted,
      message: deleted ? 'Message deleted.' : 'Message not found.',
    });
  } catch {
    return res.status(500).json({ success: false, error: 'server_error' });
  }
});

export default router;