// api/src/api-plan-change-handler.ts
// ─────────────────────────────────────────────────────────────────────────────
//  POST /user/api-plan/change
//  Upgrades or downgrades an existing Paddle API subscription in-place.
//
//  Upgrade   → proration_billing_mode: "prorated_immediately"
//              Features unlock right away; user is charged the difference.
//
//  Downgrade → proration_billing_mode: "do_not_bill"
//              Paddle schedules the item swap for next_billing_period.
//              User keeps current plan + features until period end.
//
//  After either call Paddle fires subscription.updated → paddle-handler.ts
//  UPDATED branch picks it up and persists the final state.
// ─────────────────────────────────────────────────────────────────────────────

import { Request, Response } from 'express';
import { db } from './mongo';
import { API_PLANS, ApiPlanName } from './v1/api-plans';

// ── Price-ID map from env ─────────────────────────────────────────────────────
// .env keys:
//   PADDLE_PRICE_DEVELOPER, PADDLE_PRICE_STARTUP,
//   PADDLE_PRICE_GROWTH,    PADDLE_PRICE_ENTERPRISE
function getPaddlePriceId(plan: ApiPlanName): string | null {
  const map: Partial<Record<ApiPlanName, string | undefined>> = {
    developer:  process.env.PADDLE_PRICE_DEVELOPER,
    startup:    process.env.PADDLE_PRICE_STARTUP,
    growth:     process.env.PADDLE_PRICE_GROWTH,
    enterprise: process.env.PADDLE_PRICE_ENTERPRISE,
  };
  return map[plan] ?? null;
}

const PLAN_ORDER: ApiPlanName[] = ['free', 'developer', 'startup', 'growth', 'enterprise'];

export function planChangeType(
  from: ApiPlanName, to: ApiPlanName,
): 'upgrade' | 'downgrade' | 'same' {
  const diff = PLAN_ORDER.indexOf(to) - PLAN_ORDER.indexOf(from);
  if (diff > 0) return 'upgrade';
  if (diff < 0) return 'downgrade';
  return 'same';
}

// ── Paddle REST PATCH /subscriptions/{id} ────────────────────────────────────
async function updatePaddleSubscription(
  subscriptionId: string,
  newPriceId:     string,
  upgrade:        boolean,
): Promise<{ ok: boolean; error?: string; data?: any }> {
  const baseUrl = process.env.PADDLE_ENV === 'sandbox'
    ? 'https://sandbox-api.paddle.com'
    : 'https://api.paddle.com';

  const body: Record<string, unknown> = {
    items: [{ price_id: newPriceId, quantity: 1 }],
    // Upgrades: add the prorated amount to the *next* invoice instead of
    // charging immediately. This avoids declined-card errors at change time
    // since the charge only happens on the customer's normal billing date.
    // Features are still unlocked right away via the optimistic DB write below.
    //
    // Downgrades: schedule item swap for next period, no charge/credit issued.
    proration_billing_mode: upgrade ? 'prorated_next_billing_period' : 'do_not_bill',
  };

  if (!upgrade) {
    // Prevent silent downgrade if next payment fails
    body.on_payment_failure = 'prevent_change';
  }

  // Known Paddle error codes we want to surface with a friendly message
  const PADDLE_ERROR_MESSAGES: Record<string, string> = {
    subscription_payment_declined:   'Your payment method was declined. Please update your card in the billing portal and try again.',
    subscription_not_active:         'Your subscription is not active. Please contact support.',
    subscription_update_when_paused: 'Your subscription is paused. Please resume it before changing plans.',
    invalid_price_for_subscription:  'This plan is not available for your current subscription. Please contact support.',
  };

  try {
    const res = await fetch(`${baseUrl}/subscriptions/${subscriptionId}`, {
      method:  'PATCH',
      headers: {
        Authorization: `Bearer ${process.env.PADDLE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const json = await res.json();
    if (!res.ok) {
      const code    = json?.error?.code ?? '';
      const message = PADDLE_ERROR_MESSAGES[code]
        ?? json?.error?.detail
        ?? json?.error?.type
        ?? 'Paddle API error';
      console.error('[PaddleChange] Paddle error:', JSON.stringify(json));
      return { ok: false, error: message, code };
    }
    return { ok: true, data: json?.data };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Network error contacting Paddle' };
  }
}

// ── Persist downgrade reason for analytics / support team ────────────────────
async function logPlanChangeReason(
  userId:     string,
  fromPlan:   ApiPlanName,
  toPlan:     ApiPlanName,
  changeType: 'upgrade' | 'downgrade',
  reason?:    string,
  comment?:   string,
) {
  await db.collection('plan_change_reasons').insertOne({
    userId, fromPlan, toPlan, changeType,
    reason:  reason  ?? null,
    comment: comment ?? null,
    createdAt: new Date(),
  });
}

// ═════════════════════════════════════════════════════════════════════════════
//  MAIN HANDLER
// ═════════════════════════════════════════════════════════════════════════════

export async function changeApiPlanHandler(req: Request, res: Response): Promise<any> {
  const {
    userId:     rawUserId,
    targetPlan,
    reason,   // e.g. "too_expensive" — logged for analytics
    comment,  // free-text, optional
  } = req.body as {
    userId?:     string;
    targetPlan?: ApiPlanName;
    reason?:     string;
    comment?:    string;
  };

  if (!rawUserId || !targetPlan) {
    return res.status(400).json({ success: false, message: 'userId and targetPlan are required.' });
  }
  if (!API_PLANS[targetPlan]) {
    return res.status(400).json({ success: false, message: `Unknown plan: ${targetPlan}` });
  }

  // ── Load user ─────────────────────────────────────────────────────────────
  const user = await db.collection('users').findOne({
    $or: [{ wyiUserId: rawUserId }, { linkedProviderIds: rawUserId }],
  });
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

  const currentPlan: ApiPlanName = (user.apiPlan as ApiPlanName) ?? 'free';
  const sub = user.apiSubscription;
  const change = planChangeType(currentPlan, targetPlan);

  // ── Guards ────────────────────────────────────────────────────────────────
  if (change === 'same') {
    return res.status(400).json({ success: false, message: 'You are already on this plan.' });
  }
  if (targetPlan === 'free') {
    return res.status(400).json({
      success: false,
      message: 'To cancel to the free plan please use the subscription cancellation flow.',
    });
  }
  if (currentPlan === 'free' || !sub?.subscriptionId) {
    return res.status(400).json({
      success: false,
      message: 'No active subscription found. Please subscribe first via checkout.',
      code: 'NO_SUBSCRIPTION',
    });
  }
  if (sub.status === 'SUSPENDED') {
    return res.status(400).json({
      success: false,
      message: 'Your subscription is suspended due to a failed payment. Update your payment method first.',
    });
  }

  // ── Get Paddle price ID ───────────────────────────────────────────────────
  const newPriceId = getPaddlePriceId(targetPlan);
  if (!newPriceId) {
    console.error(`[PaddleChange] Missing env PADDLE_PRICE_${targetPlan.toUpperCase()}`);
    return res.status(500).json({ success: false, message: 'Plan price not configured. Contact support.' });
  }

  const isUpgrade = change === 'upgrade';

  // ── Call Paddle ───────────────────────────────────────────────────────────
  const result = await updatePaddleSubscription(sub.subscriptionId, newPriceId, isUpgrade);
  if (!result.ok) {
    return res.status(502).json({ success: false, message: result.error });
  }

  // ── Optimistic local update ───────────────────────────────────────────────
  // Upgrades: flip plan + features immediately so the user isn't left waiting
  // for the webhook. The UPDATED webhook will be a no-op since data matches.
  // Downgrades: do NOT flip plan yet. The UPDATED webhook schedules it properly.
  if (isUpgrade) {
    const q = { $or: [{ wyiUserId: rawUserId }, { linkedProviderIds: rawUserId }] };
    await db.collection('users').updateOne(q, {
      $set: {
        apiPlan:                       targetPlan,
        'apiSubscription.planId':      newPriceId,
        'apiSubscription.status':      'ACTIVE',
        'apiSubscription.lastUpdated': new Date(),
      },
      $unset: {
        apiScheduledDowngradeAt:        '',
        'apiSubscription.canceledAt':  '',
        'apiSubscription.periodEnd':   '',
      },
    });
  } else {
    // For downgrades: record a scheduled-downgrade timestamp so the app can
    // show "your plan changes on <date>" in the dashboard.
    const paddleData    = result.data;
    const effectiveDate = paddleData?.scheduled_change?.effective_at
      ?? paddleData?.current_billing_period?.ends_at
      ?? null;

    if (effectiveDate) {
      const q = { $or: [{ wyiUserId: rawUserId }, { linkedProviderIds: rawUserId }] };
      await db.collection('users').updateOne(q, {
        $set: {
          apiScheduledDowngradePlan: targetPlan,
          apiScheduledDowngradeAt:   new Date(effectiveDate),
          'apiSubscription.lastUpdated': new Date(),
        },
      });
    }
  }

  // ── Log reason ────────────────────────────────────────────────────────────
  logPlanChangeReason(user.wyiUserId, currentPlan, targetPlan, change, reason, comment)
    .catch(err => console.error('[PaddleChange] reason log error:', err));

  console.log(
    `[PaddleChange] ${rawUserId}: ${currentPlan} → ${targetPlan} (${change})`,
    isUpgrade ? '— immediate' : `— scheduled at ${result.data?.scheduled_change?.effective_at ?? 'period end'}`,
  );

  const effectiveAt = isUpgrade
    ? new Date().toISOString()
    : result.data?.scheduled_change?.effective_at
      ?? result.data?.current_billing_period?.ends_at
      ?? null;

  return res.status(200).json({
    success:    true,
    changeType: change,
    fromPlan:   currentPlan,
    toPlan:     targetPlan,
    effectiveAt,
    message: isUpgrade
      ? `Upgraded to ${API_PLANS[targetPlan].label}. Your new features are active immediately.`
      : `Your plan will change to ${API_PLANS[targetPlan].label} on ${effectiveAt ? new Date(effectiveAt).toLocaleDateString() : 'the next billing date'}.`,
  });
}