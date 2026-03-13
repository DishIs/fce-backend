// v1/resolve-plan.ts
// ─────────────────────────────────────────────────────────────────────────────
//  Single source of truth for "what plan does this user actually have right now?"
//  Used by both api-auth.ts (every API request) and api-status-handler.ts
//  (dashboard read). Must stay in sync.
// ─────────────────────────────────────────────────────────────────────────────
import { ApiPlanName } from './api-plans';

function normStatus(raw?: string | null): string {
  if (!raw) return '';
  const up = raw.toUpperCase().trim();
  return up === 'CANCELED' ? 'CANCELLED' : up;
}

/**
 * Resolves the effective API plan at read-time.
 *
 * Returns 'free' if any of these are true:
 *   1. apiScheduledDowngradeAt has elapsed
 *   2. Subscription is CANCELLED/cancelling AND periodEnd has elapsed
 *
 * Otherwise returns the stored apiPlan as-is.
 * This means a user keeps their paid features until their period actually ends,
 * even if Paddle fires the cancellation webhook early.
 */
export function resolveEffectivePlan(user: any): ApiPlanName {
  const storedPlan: ApiPlanName = (user.apiPlan as ApiPlanName) ?? 'free';
  if (storedPlan === 'free') return 'free';

  const now = Date.now();

  // 1. Explicit scheduled-downgrade timestamp (set by paddle-handler on CANCELLED)
  if (user.apiScheduledDowngradeAt) {
    const downAt = new Date(user.apiScheduledDowngradeAt).getTime();
    if (!isNaN(downAt) && now >= downAt) return 'free';
  }

  // 2. Subscription periodEnd elapsed for cancelled/cancelling subs
  const sub = user.apiSubscription;
  if (sub) {
    const status     = normStatus(sub.status);
    const cancelAtEnd: boolean = sub.cancelAtPeriodEnd === true;
    const periodEnd  = sub.periodEnd ?? sub.canceledAt ?? null;

    if ((status === 'CANCELLED' || cancelAtEnd) && periodEnd) {
      const endMs = new Date(periodEnd).getTime();
      if (!isNaN(endMs) && now >= endMs) return 'free';
    }
  }

  return storedPlan;
}