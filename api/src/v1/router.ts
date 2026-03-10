// v1/router.ts  (updated — /v1/custom-domains added)
// ─────────────────────────────────────────────────────────────────────────────
//  Public developer API router — mounted at /v1
//  Domain: api.freecustom.email
// ─────────────────────────────────────────────────────────────────────────────
import { Router, Request, Response } from 'express';
import { apiKeyAuth } from './api-auth';
import { apiRateLimit } from './api-ratelimit';
import inboxRouter from './routes/inbox';
import domainsRouter from './routes/domains';
import customDomainsRouter from './routes/custom-domains';   // ← NEW
import { db } from '../mongo';
import { API_PLANS, CREDIT_PACKAGES } from './api-plans';

const v1Router = Router();

// ── Apply auth + rate limiting to ALL v1 routes ───────────────────────────────
v1Router.use(apiKeyAuth);
v1Router.use(apiRateLimit);

// ── Sub-routers ───────────────────────────────────────────────────────────────
v1Router.use('/inboxes', inboxRouter);
v1Router.use('/domains', domainsRouter);
v1Router.use('/custom-domains', customDomainsRouter);        // ← NEW

// ── GET /v1/me ────────────────────────────────────────────────────────────────
v1Router.get('/me', async (req: Request, res: Response): Promise<any> => {
  const apiUser = req.apiUser!;
  try {
    const user = await db.collection('users').findOne(
      { wyiUserId: apiUser.userId },
      { projection: { wyiUserId: 1, email: 1, apiPlan: 1, apiCredits: 1, apiInboxes: 1, inboxes: 1, customDomains: 1 } },
    );
    const appInboxesList  = Array.isArray(user?.inboxes)     ? user.inboxes.map((i: any) => String(i).toLowerCase())     : [];
    const apiInboxesList  = user?.apiInboxes     ?? [];
    const customDomains   = (user?.customDomains ?? []).map((d: any) => ({
      domain:    d.domain,
      verified:  !!d.verified,
      mx_record: d.mxRecord,
      txt_record: d.txtRecord,
    }));

    return res.json({
      success: true,
      data: {
        plan:               apiUser.plan,
        plan_label:         API_PLANS[apiUser.plan].label,
        price:              `$${API_PLANS[apiUser.plan].price}/mo`,
        credits:            user?.apiCredits ?? 0,
        rate_limits:        apiUser.planConfig.rateLimit,
        features:           apiUser.planConfig.features,
        app_inboxes:        appInboxesList,
        app_inbox_count:    appInboxesList.length,
        api_inboxes:        apiInboxesList,
        api_inbox_count:    apiInboxesList.length,
        custom_domains:     customDomains,
        custom_domain_count: customDomains.length,
      },
    });
  } catch {
    return res.status(500).json({ success: false, error: 'server_error' });
  }
});

// ── GET /v1/usage ─────────────────────────────────────────────────────────────
v1Router.get('/usage', async (req: Request, res: Response): Promise<any> => {
  const apiUser = req.apiUser!;
  const { client: redis } = await import('../redis');

  const monthKey = `rl:m:${apiUser.userId}:${new Date().toISOString().slice(0, 7)}`;
  try {
    const used  = parseInt((await redis.get(monthKey)) ?? '0', 10);
    const limit = apiUser.planConfig.rateLimit.requestsPerMonth;

    return res.json({
      success: true,
      data: {
        plan:               apiUser.plan,
        requests_used:      used,
        requests_limit:     limit,
        requests_remaining: Math.max(0, limit - used),
        percent_used:       ((used / limit) * 100).toFixed(1) + '%',
        credits_remaining:  apiUser.credits,
        resets:             `${new Date().toISOString().slice(0, 7)}-28T00:00:00Z`,
      },
    });
  } catch {
    return res.status(500).json({ success: false, error: 'server_error' });
  }
});

export default v1Router;

// ── Unauthenticated public plans endpoint ─────────────────────────────────────
export function createPublicV1Router(): Router {
  const pub = Router();

  pub.get('/plans', (_req: Request, res: Response) => {
    return res.json({
      success: true,
      data: {
        plans: Object.values(API_PLANS).map(p => ({
          name:         p.name,
          label:        p.label,
          price:        p.price === 0 ? 'Free' : `$${p.price}/mo`,
          rate_limit:   `${p.rateLimit.requestsPerSecond} req/s · ${p.rateLimit.requestsPerMonth.toLocaleString()} req/mo`,
          features: {
            otp_extraction:      p.features.otpExtraction,
            attachments:         p.features.attachments,
            max_attachment_size: p.features.maxAttachmentSizeMb > 0 ? `${p.features.maxAttachmentSizeMb} MB` : 'None',
            custom_domains:      p.features.customDomains,
            websocket:           p.features.websocket,
            max_ws_connections:  p.features.maxWsConnections,
          },
        })),
        credits: CREDIT_PACKAGES.map(c => ({
          price:    `$${c.priceUsd}`,
          requests: c.requests.toLocaleString(),
          label:    c.label,
          expires:  'Never',
        })),
      },
    });
  });

  pub.use('/', v1Router);
  return pub;
}