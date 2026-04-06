// api/src/handlers/api-status-handler.ts
// resolveEffectivePlan imported from shared v1/resolve-plan.ts
import { Request, Response } from 'express';
import { db } from '../config/mongo';
import { client as redis } from '../config/redis';
import { API_PLANS, ApiPlanName, CREDIT_PACKAGES } from '../v1/api-plans';
import { resolveEffectivePlan } from '../v1/resolve-plan';

function normStatus(raw?: string | null): string {
  if (!raw) return '';
  const up = raw.toUpperCase().trim();
  return up === 'CANCELED' ? 'CANCELLED' : up;
}

async function getMonthlyUsage(wyiUserId: string): Promise<number> {
  try {
    const monthStr = new Date().toISOString().slice(0, 7);
    const val = await redis.get(`rl:m:${wyiUserId}:${monthStr}`);
    return parseInt(val ?? '0', 10);
  } catch { return 0; }
}

// ── Build a unified subscription summary ──────────────────────────────────────
// Merges Paddle apiSubscription + NOWPayments apiCryptoSubscription into a single
// object the frontend can consume without knowing which provider is active.
//
// Priority: whichever sub is ACTIVE (or TRIALING) wins.
// If both are present and neither is active, return the most-recently-updated one.
function resolveActiveApiSub(user: any): {
  provider: 'paddle' | 'nowpayments' | null;
  subscription_id:      string | null;
  status:               string | null;
  cancel_at_period_end: boolean;
  period_end:           string | null;
  canceled_at:          string | null;
  next_billed_at:       string | null;
  payer_email:          string | null;
} | null {
  const paddle = user.apiSubscription ?? null;
  const crypto = user.apiCryptoSubscription ?? null;

  const paddleActive = paddle && ['ACTIVE', 'TRIALING'].includes(normStatus(paddle.status));
  const cryptoActive = crypto && ['ACTIVE'].includes(normStatus(crypto.status));

  // Both active → Paddle wins (more feature-rich provider)
  if (paddleActive) {
    return {
      provider:             'paddle',
      subscription_id:      paddle.subscriptionId,
      status:               normStatus(paddle.status),
      cancel_at_period_end: paddle.cancelAtPeriodEnd ?? false,
      period_end:           paddle.periodEnd   ?? null,
      canceled_at:          paddle.canceledAt  ?? null,
      next_billed_at:       paddle.nextBilledAt ?? null,
      payer_email:          paddle.payerEmail   ?? null,
    };
  }
  if (cryptoActive) {
    return {
      provider:             'nowpayments',
      subscription_id:      crypto.subscriptionId,
      status:               normStatus(crypto.status),
      cancel_at_period_end: crypto.cancelAtPeriodEnd ?? false,
      period_end:           crypto.periodEnd   ?? null,
      canceled_at:          crypto.canceledAt  ?? null,
      next_billed_at:       crypto.nextBilledAt ?? null,
      payer_email:          null,
    };
  }

  // Neither active — return whichever exists for history display
  const fallback = paddle ?? crypto;
  if (!fallback) return null;

  const provider: 'paddle' | 'nowpayments' = paddle ? 'paddle' : 'nowpayments';
  return {
    provider,
    subscription_id:      fallback.subscriptionId,
    status:               normStatus(fallback.status),
    cancel_at_period_end: fallback.cancelAtPeriodEnd ?? false,
    period_end:           fallback.periodEnd   ?? null,
    canceled_at:          fallback.canceledAt  ?? null,
    next_billed_at:       fallback.nextBilledAt ?? null,
    payer_email:          (fallback as any).payerEmail ?? null,
  };
}

export async function getApiStatusHandler(req: Request, res: Response): Promise<any> {
  const { wyiUserId } = req.params;
  if (!wyiUserId) return res.status(400).json({ success: false, message: 'wyiUserId is required.' });

  try {
    const user = await db.collection('users').findOne({
      $or: [{ wyiUserId }, { linkedProviderIds: wyiUserId }],
    });
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    const plan: ApiPlanName = resolveEffectivePlan(user);
    const planConfig        = API_PLANS[plan];
    const credits: number   = (user.apiCredits ?? 0) + (user.proBonusCredits ?? 0);
    const appInboxes        = Array.isArray(user.inboxes)
      ? user.inboxes.map((i: any) => String(i).toLowerCase())
      : [];
    const apiInboxes = user.apiInboxes ?? [];

    // Resolved unified subscription (Paddle preferred over NP when both active)
    const activeSub = resolveActiveApiSub(user);

    const monthlyUsed      = await getMonthlyUsage(user.wyiUserId);
    const monthlyLimit     = planConfig.rateLimit.requestsPerMonth;
    const monthlyRemaining = Math.max(0, monthlyLimit - monthlyUsed);
    const percentUsed      = ((monthlyUsed / monthlyLimit) * 100).toFixed(1);

    // ── Next-plan diff ────────────────────────────────────────────────────────
    const planOrder: ApiPlanName[] = ['free', 'developer', 'startup', 'growth', 'enterprise'];
    const currentIndex   = planOrder.indexOf(plan);
    const nextPlan       = currentIndex < planOrder.length - 1 ? planOrder[currentIndex + 1] : null;
    const nextPlanConfig = nextPlan ? API_PLANS[nextPlan] : null;

    // ── Upsell nudges ─────────────────────────────────────────────────────────
    const upsellNudges: string[] = [];
    if (!planConfig.features.otpExtraction)
      upsellNudges.push('Upgrade to Growth ($49/mo) to unlock OTP & verification-link extraction.');
    if (!planConfig.features.websocket)
      upsellNudges.push('Upgrade to Startup ($19/mo) to unlock real-time WebSocket events.');
    if (!planConfig.features.attachments)
      upsellNudges.push('Upgrade to Startup ($19/mo) to unlock email attachment access.');
    if (!planConfig.features.customDomains)
      upsellNudges.push('Upgrade to Growth ($49/mo) to use custom domain inboxes.');
    if (monthlyUsed / monthlyLimit >= 0.8)
      upsellNudges.push(`You've used ${percentUsed}% of your monthly quota. Consider upgrading or buying credits.`);

    // ── Subscription badge ────────────────────────────────────────────────────
    // Works for both Paddle and NP providers using the resolved activeSub.
    let subscriptionBadge = plan === 'free' ? 'free' : 'active';
    if (activeSub) {
      const s = activeSub.status ?? '';
      if (s === 'TRIALING')  subscriptionBadge = 'trialing';
      if (s === 'SUSPENDED' || s === 'PENDING_RENEWAL') subscriptionBadge = 'payment_failed';
      if (activeSub.cancel_at_period_end) {
        const periodEnd = activeSub.period_end ?? activeSub.canceled_at ?? null;
        const expired   = periodEnd && Date.now() >= new Date(periodEnd).getTime();
        subscriptionBadge = expired ? 'cancelled' : 'cancelling';
      }
      if (s === 'CANCELLED') subscriptionBadge = 'cancelled';
    }
    if (plan === 'free' && user.apiPlan && user.apiPlan !== 'free')
      subscriptionBadge = 'cancelled';

    // ── Next-plan unlocks ─────────────────────────────────────────────────────
    const nextPlanUnlocks: string[] = [];
    if (nextPlanConfig) {
      if (!planConfig.features.otpExtraction    && nextPlanConfig.features.otpExtraction)    nextPlanUnlocks.push('OTP & verification-link extraction');
      if (!planConfig.features.websocket        && nextPlanConfig.features.websocket)        nextPlanUnlocks.push('WebSocket real-time events');
      if (!planConfig.features.attachments      && nextPlanConfig.features.attachments)      nextPlanUnlocks.push('Email attachment access');
      if (!planConfig.features.customDomains    && nextPlanConfig.features.customDomains)    nextPlanUnlocks.push('Custom domain inboxes');
      nextPlanUnlocks.push(
        `${nextPlanConfig.rateLimit.requestsPerMonth.toLocaleString()} req/mo` +
        ` (vs current ${planConfig.rateLimit.requestsPerMonth.toLocaleString()})`,
      );
    }

    return res.status(200).json({
      success: true,
      data: {
        plan: {
          name:         plan,
          label:        planConfig.label,
          price:        planConfig.price === 0 ? 'Free' : `$${planConfig.price}/mo`,
          status_badge: subscriptionBadge,
        },

        // ── Active subscription (unified across Paddle + NP) ──────────────────
        subscription: activeSub,

        // ── Provider-specific raw subs (for UI decisions) ─────────────────────
        // Frontend uses these to know which provider's plan-change flow to invoke.
        paddle_subscription: user.apiSubscription
          ? {
              subscription_id:      user.apiSubscription.subscriptionId,
              status:               normStatus(user.apiSubscription.status),
              cancel_at_period_end: user.apiSubscription.cancelAtPeriodEnd ?? false,
              period_end:           user.apiSubscription.periodEnd   ?? null,
              canceled_at:          user.apiSubscription.canceledAt  ?? null,
              next_billed_at:       user.apiSubscription.nextBilledAt ?? null,
              payer_email:          user.apiSubscription.payerEmail   ?? null,
            }
          : null,

        crypto_subscription: user.apiCryptoSubscription
          ? {
              subscription_id:      user.apiCryptoSubscription.subscriptionId,
              status:               normStatus(user.apiCryptoSubscription.status),
              cancel_at_period_end: user.apiCryptoSubscription.cancelAtPeriodEnd ?? false,
              period_end:           user.apiCryptoSubscription.periodEnd  ?? null,
              canceled_at:          user.apiCryptoSubscription.canceledAt ?? null,
            }
          : null,

        // ── Scheduled downgrade (both providers write to same fields) ─────────
        scheduledDowngradePlan: user.apiScheduledDowngradePlan ?? null,
        scheduledDowngradeAt:   user.apiScheduledDowngradeAt
          ? new Date(user.apiScheduledDowngradeAt).toISOString()
          : null,

        usage: {
          requests_this_month: monthlyUsed,
          requests_limit:      monthlyLimit,
          requests_remaining:  monthlyRemaining,
          percent_used:        percentUsed + '%',
          credits_remaining:   credits,
          resets_approx: new Date(
            new Date().getFullYear(),
            new Date().getMonth() + 1,
            1,
          ).toISOString(),
        },

        rate_limits: {
          requests_per_second: planConfig.rateLimit.requestsPerSecond,
          requests_per_month:  planConfig.rateLimit.requestsPerMonth,
        },

        features: {
          otp_extraction:     planConfig.features.otpExtraction,
          attachments:        planConfig.features.attachments,
          max_attachment_mb:  planConfig.features.maxAttachmentSizeMb,
          custom_domains:     planConfig.features.customDomains,
          websocket:          planConfig.features.websocket,
          max_ws_connections: planConfig.features.maxWsConnections,
        },

        app_inboxes: { list: appInboxes, count: appInboxes.length },
        api_inboxes: { list: apiInboxes, count: apiInboxes.length },
        inboxes:     { list: apiInboxes, count: apiInboxes.length },

        upsell: {
          nudges:    upsellNudges,
          next_plan: nextPlanConfig
            ? {
                name:    nextPlan,
                label:   nextPlanConfig.label,
                price:   `$${nextPlanConfig.price}/mo`,
                unlocks: nextPlanUnlocks,
              }
            : null,
          credit_packages: CREDIT_PACKAGES.map(c => ({
            price:    `$${c.priceUsd}`,
            requests: c.requests.toLocaleString(),
            label:    c.label,
          })),
        },

        all_plans: Object.values(API_PLANS).map(p => ({
          name:        p.name,
          label:       p.label,
          price:       p.price === 0 ? 'Free' : `$${p.price}/mo`,
          current:     p.name === plan,
          rps:         p.rateLimit.requestsPerSecond,
          rpm:         p.rateLimit.requestsPerMonth,
          otp:         p.features.otpExtraction,
          websocket:   p.features.websocket,
          attachments: p.features.attachments,
          domains:     p.features.customDomains,
        })),
      },
    });
  } catch (err) {
    console.error('[getApiStatusHandler]', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
}