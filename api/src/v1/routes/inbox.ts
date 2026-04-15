import { getTimeline, getInsights } from '../../services/events-service';
// api/src/v1/routes/inbox.ts
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
import { getInbox, getMessage, deleteMessageById } from '../../services/mailbox';
import { db } from '../../config/mongo';
import { client as redis } from '../../config/redis';
import { getDomainEntry } from '../../services/domain-registry';            // ← from registry
import {
  API_PLANS,
  ApiPlanName,
  apiPlanToInternalPlan,
  OTP_PLANS,
  CUSTOM_DOMAIN_PLANS,
} from '../api-plans';
import { globalEvents } from '../../services/events';

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

 
/** Strip or tease OTP/verificationLink fields based on the caller's plan.
 *  OTP is gated to Growth + Enterprise (OTP_PLANS).
 *  Developer / Startup users see __DETECTED__ with a correct upgrade hint.
 */
function sanitizeMessage(msg: any, plan: ApiPlanName): any {
  if (!OTP_PLANS.includes(plan)) {
    const hasOtpData = !!(msg.otp || msg.verificationLink);
    return {
      ...msg,
      otp:               msg.otp               ? '__DETECTED__' : null,
      verificationLink:  msg.verificationLink   ? '__DETECTED__' : null,
      _upgrade_hint: hasOtpData
        ? 'Upgrade to Growth plan ($49/mo) to unlock OTP & verification-link extraction.'
        : undefined,
    };
  }
  return msg;
}


/** Filter/strip attachments based on the plan's size limit.
 *  Attachments are gated to Startup + (attachments: true in API_PLANS).
 */
function sanitizeAttachments(msg: any, plan: ApiPlanName): any {
  const cfg = API_PLANS[plan];
  if (!cfg.features.attachments) {
    const { attachments: _a, ...rest } = msg;
    return {
      ...rest,
      _attachments_blocked: msg.attachments?.length
        ? 'Attachments require Startup plan ($19/mo) or above.'
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
    const apiInboxesList: string[] = user?.apiInboxes ?? [];
 
    // `data` returns objects so Make/Zapier can map individual fields.
    // `api_inboxes` keeps the flat string array for backwards compat
    // with any existing direct API consumers.
    const dataObjects = apiInboxesList.map((addr: string) => ({
      inbox:  addr,
      local:  addr.split('@')[0],
      domain: addr.split('@')[1],
    }));
 
    return res.json({
      success:         true,
      data:            dataObjects,
      count:           apiInboxesList.length,
      api_inboxes:     apiInboxesList,
      api_inbox_count: apiInboxesList.length,
    });
  } catch {
    return res.status(500).json({ success: false, error: 'server_error' });
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/inboxes — register an inbox
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', async (req: Request, res: Response): Promise<any> => {
  const { inbox, isTesting } = req.body;
  const apiUser   = req.apiUser!;

  if (isTesting && !apiUser.planConfig.features.testingInboxes) {
    return res.status(403).json({
      success: false,
      error: 'plan_restriction',
      message: 'Testing inboxes require Growth plan ($49/mo) or above.',
      upgrade_url: 'https://freecustom.email/api/pricing',
    });
  }

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

    // ── Enforce max inboxes limit ───────────────────────────────────────────
    const maxInboxes = apiUser.planConfig.features.maxInboxes;
    const currentInboxCount = (user.apiInboxes || []).length;
    
    // Check if the user is trying to add a new inbox (not already registered)
    const already = (user.apiInboxes ?? []).includes(normalized);
    if (already) {
      return res.json({ success: true, message: 'Inbox already registered.', inbox: normalized });
    }

    if (maxInboxes > 0 && currentInboxCount >= maxInboxes) {
      return res.status(403).json({
        success: false,
        error: 'inbox_limit_reached',
        message: `Your plan (${apiUser.planConfig.label}) is limited to ${maxInboxes} registered inboxes. Upgrade your plan to add more inboxes.`,
        upgrade_url: 'https://freecustom.email/api/pricing',
      });
    }

    const updateQuery: any = { $addToSet: { apiInboxes: normalized } };
    if (isTesting) {
      updateQuery.$addToSet.testingInboxes = normalized;
    }

    await db.collection('users').updateOne(
      { wyiUserId: apiUser.userId },
      updateQuery,
    );

    const internalPlan = apiPlanToInternalPlan(apiUser.plan);
    await redis.set(
      `user_data_cache:${normalized}`,
      JSON.stringify({ plan: internalPlan, userId: user._id, isVerified: !isProvidedDomain, isTesting: !!isTesting }),
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
      message:     'OTP extraction requires Growth plan ($49/mo) or above.',
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
      score:             latest.otpScore,
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

// ─────────────────────────────────────────────────────────────────────────────
// GET /v1/inboxes/:inbox/wait — long-polling wait for new emails
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:inbox/wait', async (req: Request, res: Response): Promise<any> => {
  const inbox = req.params.inbox.toLowerCase();
  const apiUser = req.apiUser!;

  if (apiUser.plan === 'free') {
    return res.status(403).json({
      success: false,
      error: 'plan_required',
      message: 'The Wait API requires a Developer plan or above.',
      upgrade_required: true,
      recommended_plan: 'developer',
      pricing_url: 'https://freecustom.email/api/pricing',
      upgrade_url: 'https://freecustom.email/api/pricing',
    });
  }

  if (!(await assertOwned(apiUser.userId, inbox))) {
    return res.status(403).json({
      success: false,
      error: 'inbox_not_owned',
      message: 'Register this inbox first via POST /v1/inboxes.',
    });
  }

  let timeout = parseInt(req.query.timeout as string, 10);
  if (isNaN(timeout)) timeout = 30;
  if (timeout < 10) timeout = 10;
  if (timeout > 60) timeout = 60;

  const since = req.query.since as string | undefined;
  const internalPlan = apiPlanToInternalPlan(apiUser.plan);

  // Apply premium rate limiting cost (Wait call = 10 normal calls)
  // We've already been charged 1 call by the rate-limit middleware, so we add 9
  const monthKey = `rl:m:${apiUser.userId}:${new Date().toISOString().slice(0, 7)}`;
  await redis.incrBy(monthKey, 9).catch(() => {});

  if (since) {
    const messages = await getInbox(inbox, internalPlan) as any[];
    const sinceIndex = messages.findIndex(m => m.id === since);
    
    if (sinceIndex > 0) {
      // Return the newest message that arrived after 'since'
      const newest = messages[0];
      const sanitized = sanitizeAttachments(sanitizeMessage(newest, apiUser.plan), apiUser.plan);
      return res.json({ success: true, message: 'New message received', data: sanitized });
    }
  }

  // Hold request
  const eventName = `mailbox:${inbox}`;
  
  let timer: NodeJS.Timeout;

  const onNewEmail = (event: any) => {
    clearTimeout(timer);
    const sanitized = sanitizeAttachments(sanitizeMessage(event, apiUser.plan), apiUser.plan);
    if (!res.headersSent) {
      res.json({ success: true, message: 'New message received', data: sanitized });
    }
  };

  timer = setTimeout(() => {
    globalEvents.off(eventName, onNewEmail);
    if (!res.headersSent) {
      res.json({ success: false, message: 'Timeout reached' });
    }
  }, timeout * 1000);

  globalEvents.once(eventName, onNewEmail);

  req.on('close', () => {
    globalEvents.off(eventName, onNewEmail);
    clearTimeout(timer);
  });
});

export default router;
