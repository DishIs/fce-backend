// api/src/handlers/api-status-handler.ts
// resolveEffectivePlan now imported from shared v1/resolve-plan.ts
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
    const credits: number   = user.apiCredits ?? 0;
    const appInboxes        = Array.isArray(user.inboxes) ? user.inboxes.map((i: any) => String(i).toLowerCase()) : [];
    const apiInboxes        = user.apiInboxes ?? [];
    const sub               = user.apiSubscription ?? null;

    const monthlyUsed      = await getMonthlyUsage(user.wyiUserId);
    const monthlyLimit     = planConfig.rateLimit.requestsPerMonth;
    const monthlyRemaining = Math.max(0, monthlyLimit - monthlyUsed);
    const percentUsed      = ((monthlyUsed / monthlyLimit) * 100).toFixed(1);

    const planOrder: ApiPlanName[] = ['free', 'developer', 'startup', 'growth', 'enterprise'];
    const currentIndex   = planOrder.indexOf(plan);
    const nextPlan       = currentIndex < planOrder.length - 1 ? planOrder[currentIndex + 1] : null;
    const nextPlanConfig = nextPlan ? API_PLANS[nextPlan] : null;

    const upsellNudges: string[] = [];
    if (!planConfig.features.otpExtraction) upsellNudges.push('Upgrade to Growth ($49/mo) to unlock OTP extraction.');
    if (!planConfig.features.websocket)     upsellNudges.push('Upgrade to Startup ($19/mo) to unlock real-time WebSocket events.');
    if (!planConfig.features.customDomains) upsellNudges.push('Upgrade to Growth ($49/mo) to use custom domain inboxes.');
    if (monthlyUsed / monthlyLimit >= 0.8)  upsellNudges.push(`You've used ${percentUsed}% of your monthly quota. Consider upgrading or buying credits.`);

    let subscriptionBadge = plan === 'free' ? 'free' : 'active';
    if (sub) {
      const s = normStatus(sub.status);
      if (s === 'TRIALING')  subscriptionBadge = 'trialing';
      if (s === 'SUSPENDED') subscriptionBadge = 'payment_failed';
      if (sub.cancelAtPeriodEnd) {
        const periodEnd = sub.periodEnd ?? sub.canceledAt ?? null;
        const expired   = periodEnd && Date.now() >= new Date(periodEnd).getTime();
        subscriptionBadge = expired ? 'cancelled' : 'cancelling';
      }
      if (s === 'CANCELLED') subscriptionBadge = 'cancelled';
    }
    if (plan === 'free' && user.apiPlan && user.apiPlan !== 'free') subscriptionBadge = 'cancelled';

    return res.status(200).json({
      success: true,
      data: {
        plan: { name: plan, label: planConfig.label, price: planConfig.price === 0 ? 'Free' : `$${planConfig.price}/mo`, status_badge: subscriptionBadge },
        subscription: sub ? { subscription_id: sub.subscriptionId, status: normStatus(sub.status), cancel_at_period_end: sub.cancelAtPeriodEnd ?? false, period_end: sub.periodEnd ?? null, canceled_at: sub.canceledAt ?? null, next_billed_at: sub.nextBilledAt ?? null, payer_email: sub.payerEmail ?? null } : null,
        usage: { requests_this_month: monthlyUsed, requests_limit: monthlyLimit, requests_remaining: monthlyRemaining, percent_used: percentUsed + '%', credits_remaining: credits, resets_approx: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1).toISOString() },
        rate_limits: { requests_per_second: planConfig.rateLimit.requestsPerSecond, requests_per_month: planConfig.rateLimit.requestsPerMonth },
        features: { otp_extraction: planConfig.features.otpExtraction, attachments: planConfig.features.attachments, max_attachment_mb: planConfig.features.maxAttachmentSizeMb, custom_domains: planConfig.features.customDomains, websocket: planConfig.features.websocket, max_ws_connections: planConfig.features.maxWsConnections },
        app_inboxes: { list: appInboxes, count: appInboxes.length },
        api_inboxes: { list: apiInboxes, count: apiInboxes.length },
        inboxes:     { list: apiInboxes, count: apiInboxes.length },
        upsell: {
          nudges: upsellNudges,
          next_plan: nextPlanConfig ? { name: nextPlan, label: nextPlanConfig.label, price: `$${nextPlanConfig.price}/mo`, unlocks: [ !planConfig.features.otpExtraction && nextPlanConfig.features.otpExtraction ? 'OTP extraction' : null, !planConfig.features.websocket && nextPlanConfig.features.websocket ? 'WebSocket access' : null, !planConfig.features.attachments && nextPlanConfig.features.attachments ? 'Attachment support' : null, !planConfig.features.customDomains && nextPlanConfig.features.customDomains ? 'Custom domains' : null, `${nextPlanConfig.rateLimit.requestsPerMonth.toLocaleString()} req/mo (vs current ${planConfig.rateLimit.requestsPerMonth.toLocaleString()})` ].filter(Boolean) } : null,
          credit_packages: CREDIT_PACKAGES.map(c => ({ price: `$${c.priceUsd}`, requests: c.requests.toLocaleString(), label: c.label })),
        },
        all_plans: Object.values(API_PLANS).map(p => ({ name: p.name, label: p.label, price: p.price === 0 ? 'Free' : `$${p.price}/mo`, current: p.name === plan, rps: p.rateLimit.requestsPerSecond, rpm: p.rateLimit.requestsPerMonth, otp: p.features.otpExtraction, websocket: p.features.websocket, attachments: p.features.attachments, domains: p.features.customDomains })),
      },
    });
  } catch (err) {
    console.error('[getApiStatusHandler]', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
}