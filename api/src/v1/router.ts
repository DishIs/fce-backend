// v1/router.ts
// ─────────────────────────────────────────────────────────────────────────────
//  Public developer API router — mounted at /v1
//  Domain: api.freecustom.email
//  Auth: API key only (no internal API key required)
// ─────────────────────────────────────────────────────────────────────────────
import { Router, Request, Response } from 'express';
import { apiKeyAuth } from './api-auth';
import { apiRateLimit } from './api-ratelimit';
import inboxRouter from './routes/inbox';
import { db } from '../mongo';
import { API_PLANS, CREDIT_PACKAGES } from './api-plans';

const v1Router = Router();

// ── Apply auth + rate limiting to ALL v1 routes ───────────────────────────────
v1Router.use(apiKeyAuth);
v1Router.use(apiRateLimit);

// ── Sub-routers ───────────────────────────────────────────────────────────────
v1Router.use('/inboxes', inboxRouter);

// ── GET /v1/me — account info ─────────────────────────────────────────────────
v1Router.get('/me', async (req: Request, res: Response): Promise<any> => {
  const apiUser = req.apiUser!;
  try {
    const user = await db.collection('users').findOne(
      { wyiUserId: apiUser.userId },
      { projection: { wyiUserId: 1, email: 1, apiPlan: 1, apiCredits: 1, apiInboxes: 1, inboxes: 1 } },
    );
    const appInboxesList = Array.isArray(user?.inboxes) ? user.inboxes.map((i: any) => String(i).toLowerCase()) : [];
    const apiInboxesList = user?.apiInboxes ?? [];

    return res.json({
      success: true,
      data: {
        plan:            apiUser.plan,
        plan_label:      API_PLANS[apiUser.plan].label,
        price:           `$${API_PLANS[apiUser.plan].price}/mo`,
        credits:         user?.apiCredits ?? 0,
        rate_limits:     apiUser.planConfig.rateLimit,
        features:        apiUser.planConfig.features,
        app_inboxes:     appInboxesList,
        app_inbox_count: appInboxesList.length,
        api_inboxes:     apiInboxesList,
        api_inbox_count: apiInboxesList.length,
      },
    });
  } catch {
    return res.status(500).json({ success: false, error: 'server_error' });
  }
});

// ── GET /v1/plans — public plan comparison (no auth) ─────────────────────────
//    (Applied before the auth middleware below, so auth is not required)

// ── GET /v1/usage — current period usage stats ────────────────────────────────
v1Router.get('/usage', async (req: Request, res: Response): Promise<any> => {
  const apiUser = req.apiUser!;
  const { client: redis } = await import('../redis');

  const monthKey = `rl:m:${apiUser.apiKeyId}:${new Date().toISOString().slice(0, 7)}`;
  try {
    const used = parseInt((await redis.get(monthKey)) ?? '0', 10);
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
        resets:             `${new Date().toISOString().slice(0, 7)}-28T00:00:00Z`, // approximate
      },
    });
  } catch {
    return res.status(500).json({ success: false, error: 'server_error' });
  }
});

export default v1Router;

// ── Separate unauthenticated plans endpoint (export for use in server.ts) ─────
export function createPublicV1Router(): Router {
  const pub = Router();

  // GET /v1/plans — list all plans + credit packages (no auth)
  pub.get('/plans', (_req: Request, res: Response) => {
    return res.json({
      success: true,
      data: {
        plans: Object.values(API_PLANS).map(p => ({
          name:             p.name,
          label:            p.label,
          price:            p.price === 0 ? 'Free' : `$${p.price}/mo`,
          rate_limit:       `${p.rateLimit.requestsPerSecond} req/s · ${p.rateLimit.requestsPerMonth.toLocaleString()} req/mo`,
          features: {
            otp_extraction:          p.features.otpExtraction,
            attachments:             p.features.attachments,
            max_attachment_size:     p.features.maxAttachmentSizeMb > 0 ? `${p.features.maxAttachmentSizeMb} MB` : 'None',
            custom_domains:          p.features.customDomains,
            websocket:               p.features.websocket,
            max_ws_connections:      p.features.maxWsConnections,
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

  // Mount authenticated sub-router
  pub.use('/', v1Router);

  return pub;
}