// api/src/api-status-handler.ts
// ─────────────────────────────────────────────────────────────────────────────
//  GET  /user/api-status/:wyiUserId   — full API account snapshot for dashboard
//  GET  /user/api-keys/:wyiUserId     — re-exported from api-key-handler.ts
//
//  Protected by internalApiAuth (same as all other /user/* routes).
//  The Next.js dashboard calls this to render:
//    • Current API plan + status badge
//    • Credits remaining
//    • Rate limit info
//    • Registered inboxes
//    • Active subscription details (cancelAtPeriodEnd, nextBilledAt, etc.)
//    • Feature flags (otp, ws, attachments, customDomains)
//    • Upsell nudges
// ─────────────────────────────────────────────────────────────────────────────
import { Request, Response } from 'express';
import { db } from './mongo';
import { client as redis } from './redis';
import { API_PLANS, ApiPlanName, WS_PLANS, OTP_PLANS, CREDIT_PACKAGES } from './v1/api-plans';

// ── Monthly usage helper ──────────────────────────────────────────────────────

async function getMonthlyUsage(wyiUserId: string): Promise<number> {
  try {
    // Find the user's most recently used active key
    const keyDoc = await db
      .collection('api_keys')
      .findOne({ wyiUserId, active: true }, { sort: { lastUsedAt: -1 } });

    if (!keyDoc) return 0;

    const monthStr = new Date().toISOString().slice(0, 7);
    const val      = await redis.get(`rl:m:${keyDoc._id.toString()}:${monthStr}`);
    return parseInt(val ?? '0', 10);
  } catch {
    return 0;
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function getApiStatusHandler(req: Request, res: Response): Promise<any> {
  const { wyiUserId } = req.params;

  if (!wyiUserId) {
    return res.status(400).json({ success: false, message: 'wyiUserId is required.' });
  }

  try {
    const user = await db.collection('users').findOne({
      $or: [{ wyiUserId }, { linkedProviderIds: wyiUserId }],
    });

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    const plan: ApiPlanName           = (user.apiPlan as ApiPlanName) ?? 'free';
    const planConfig                  = API_PLANS[plan];
    const credits: number             = user.apiCredits ?? 0;
    const apiInboxes: string[]        = user.apiInboxes ?? [];
    const sub                         = user.apiSubscription ?? null;

    const monthlyUsed                 = await getMonthlyUsage(user.wyiUserId);
    const monthlyLimit                = planConfig.rateLimit.requestsPerMonth;
    const monthlyRemaining            = Math.max(0, monthlyLimit - monthlyUsed);
    const percentUsed                 = ((monthlyUsed / monthlyLimit) * 100).toFixed(1);

    // ── Next plan upsell hint ─────────────────────────────────────────────────
    const planOrder: ApiPlanName[] = ['free', 'developer', 'startup', 'growth', 'enterprise'];
    const currentIndex             = planOrder.indexOf(plan);
    const nextPlan                 = currentIndex < planOrder.length - 1
      ? planOrder[currentIndex + 1]
      : null;
    const nextPlanConfig           = nextPlan ? API_PLANS[nextPlan] : null;

    // Build upsell nudges based on what the current plan is missing
    const upsellNudges: string[] = [];
    if (!planConfig.features.otpExtraction)  upsellNudges.push('Upgrade to Developer ($7/mo) to unlock OTP extraction.');
    if (!planConfig.features.websocket)      upsellNudges.push('Upgrade to Startup ($19/mo) to unlock real-time WebSocket events.');
    if (!planConfig.features.customDomains)  upsellNudges.push('Upgrade to Growth ($49/mo) to use custom domain inboxes.');
    if (monthlyUsed / monthlyLimit >= 0.8)   upsellNudges.push(`You've used ${percentUsed}% of your monthly quota. Consider upgrading or buying credits.`);

    // ── Subscription status badge ─────────────────────────────────────────────
    let subscriptionBadge: string = plan === 'free' ? 'free' : 'active';
    if (sub) {
      if (sub.status === 'TRIALING')           subscriptionBadge = 'trialing';
      if (sub.status === 'SUSPENDED')          subscriptionBadge = 'payment_failed';
      if (sub.cancelAtPeriodEnd)               subscriptionBadge = 'cancelling';
      if (sub.status === 'CANCELLED')          subscriptionBadge = 'cancelled';
    }

    return res.status(200).json({
      success: true,
      data: {
        // ── Plan ───────────────────────────────────────────────────────────────
        plan: {
          name:         plan,
          label:        planConfig.label,
          price:        planConfig.price === 0 ? 'Free' : `$${planConfig.price}/mo`,
          status_badge: subscriptionBadge,
        },

        // ── Subscription state (null for free / credits-only users) ────────────
        subscription: sub
          ? {
              subscription_id:      sub.subscriptionId,
              status:               sub.status,
              cancel_at_period_end: sub.cancelAtPeriodEnd ?? false,
              period_end:           sub.periodEnd ?? null,
              canceled_at:          sub.canceledAt ?? null,
              next_billed_at:       sub.nextBilledAt ?? null,
              payer_email:          sub.payerEmail ?? null,
            }
          : null,

        // ── Usage ──────────────────────────────────────────────────────────────
        usage: {
          requests_this_month: monthlyUsed,
          requests_limit:      monthlyLimit,
          requests_remaining:  monthlyRemaining,
          percent_used:        percentUsed + '%',
          credits_remaining:   credits,
          resets_approx:       new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1).toISOString(),
        },

        // ── Rate limits ────────────────────────────────────────────────────────
        rate_limits: {
          requests_per_second:  planConfig.rateLimit.requestsPerSecond,
          requests_per_month:   planConfig.rateLimit.requestsPerMonth,
        },

        // ── Feature flags (for conditional UI rendering) ───────────────────────
        features: {
          otp_extraction:       planConfig.features.otpExtraction,
          attachments:          planConfig.features.attachments,
          max_attachment_mb:    planConfig.features.maxAttachmentSizeMb,
          custom_domains:       planConfig.features.customDomains,
          websocket:            planConfig.features.websocket,
          max_ws_connections:   planConfig.features.maxWsConnections,
        },

        // ── Inboxes ────────────────────────────────────────────────────────────
        inboxes: {
          list:  apiInboxes,
          count: apiInboxes.length,
        },

        // ── Upsell ─────────────────────────────────────────────────────────────
        upsell: {
          nudges:      upsellNudges,
          next_plan:   nextPlanConfig
            ? {
                name:  nextPlan,
                label: nextPlanConfig.label,
                price: `$${nextPlanConfig.price}/mo`,
                unlocks: [
                  !planConfig.features.otpExtraction  && nextPlanConfig.features.otpExtraction  ? 'OTP extraction'      : null,
                  !planConfig.features.websocket       && nextPlanConfig.features.websocket       ? 'WebSocket access'    : null,
                  !planConfig.features.attachments     && nextPlanConfig.features.attachments     ? 'Attachment support'  : null,
                  !planConfig.features.customDomains   && nextPlanConfig.features.customDomains   ? 'Custom domains'      : null,
                  `${nextPlanConfig.rateLimit.requestsPerMonth.toLocaleString()} req/mo (vs current ${planConfig.rateLimit.requestsPerMonth.toLocaleString()})`,
                ].filter(Boolean),
              }
            : null,
          credit_packages: CREDIT_PACKAGES.map(c => ({
            price:    `$${c.priceUsd}`,
            requests: c.requests.toLocaleString(),
            label:    c.label,
          })),
        },

        // ── Plan comparison (full table — useful for pricing page too) ──────────
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