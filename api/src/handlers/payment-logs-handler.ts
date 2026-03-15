// api/src/handlers/payment-logs-handler.ts
// ─────────────────────────────────────────────────────────────────────────────
//  GET /user/payment-logs/:wyiUserId
//  Protected by internalApiAuth — called by the Next.js billing/dashboard page.
//
//  Returns all payment_logs for the user, enriched with human-readable labels
//  derived directly from the raw Paddle event payload so the frontend never
//  has to touch the raw `details` blob.
// ─────────────────────────────────────────────────────────────────────────────
import { Request, Response } from 'express';
import { db } from '../config/mongo';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Pull the friendliest product name out of a Paddle items array */
function extractProductName(details: any): string {
  const items = details?.data?.items;
  if (Array.isArray(items) && items.length > 0) {
    return items[0]?.product?.name ?? items[0]?.price?.name ?? 'Unknown product';
  }
  return 'Unknown product';
}

/** Derive billing interval label from Paddle billing_cycle */
function extractBillingCycle(details: any): string | null {
  const bc = details?.data?.billing_cycle ?? details?.data?.items?.[0]?.price?.billing_cycle;
  if (!bc) return null;
  const { frequency, interval } = bc;
  if (frequency === 1 && interval === 'month') return 'Monthly';
  if (frequency === 1 && interval === 'year')  return 'Yearly';
  return `Every ${frequency} ${interval}(s)`;
}

/** Format Paddle amount string ("399") → "$3.99" */
function formatAmount(details: any): string | null {
  const raw      = details?.data?.items?.[0]?.price?.unit_price?.amount;
  const currency = details?.data?.currency_code ?? details?.data?.items?.[0]?.price?.unit_price?.currency_code ?? 'USD';
  if (raw == null) return null;
  const cents = parseInt(raw, 10);
  if (isNaN(cents)) return null;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}

/** Determine if the item was a trial at the time of this event */
function extractTrialInfo(details: any): { isTrial: boolean; trialEndsAt: string | null } {
  const item = details?.data?.items?.[0];
  return {
    isTrial:     item?.status === 'trialing',
    trialEndsAt: item?.trial_dates?.ends_at ?? null,
  };
}

/** Map raw transactionType + Paddle event_type → user-facing label */
function labelForEvent(transactionType: string, details: any): string {
  const paddleEvent = details?.event_type as string | undefined;

  // Use Paddle's own event_type when available for precision
  if (paddleEvent) {
    const map: Record<string, string> = {
      'subscription.created':   'Subscription started',
      'subscription.activated': 'Subscription activated',
      'subscription.updated':   'Subscription updated',
      'subscription.canceled':  'Subscription cancelled',
      'subscription.paused':    'Subscription paused',
      'subscription.resumed':   'Subscription resumed',
      'transaction.completed':  'Payment received',
      'transaction.refunded':   'Refund issued',
      'transaction.payment_failed': 'Payment failed',
    };
    if (map[paddleEvent]) return map[paddleEvent];
  }

  // Fallback to our own transactionType field
  const fallback: Record<string, string> = {
    subscription_created:   'Subscription started',
    subscription_renewed:   'Subscription renewed',
    subscription_cancelled: 'Subscription cancelled',
    refund:                 'Refund issued',
  };
  return fallback[transactionType] ?? transactionType;
}

/** Map raw status → badge string */
function statusBadge(details: any, transactionType: string): {
  label: string; color: 'green' | 'yellow' | 'red' | 'gray';
} {
  const subStatus = details?.data?.status as string | undefined;

  if (transactionType === 'refund') return { label: 'Refunded', color: 'gray' };

  const map: Record<string, { label: string; color: 'green' | 'yellow' | 'red' | 'gray' }> = {
    trialing:  { label: 'Trial',     color: 'yellow' },
    active:    { label: 'Active',    color: 'green'  },
    canceled:  { label: 'Cancelled', color: 'red'    },
    paused:    { label: 'Paused',    color: 'yellow' },
    past_due:  { label: 'Past due',  color: 'red'    },
  };

  return map[subStatus ?? ''] ?? { label: 'Completed', color: 'green' };
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function getPaymentLogsHandler(req: Request, res: Response): Promise<any> {
  const { wyiUserId } = req.params;
  if (!wyiUserId) {
    return res.status(400).json({ success: false, message: 'wyiUserId is required.' });
  }

  // Optional query params
  const limit  = Math.min(parseInt((req.query.limit  as string) ?? '50',  10), 200);
  const offset = Math.max(parseInt((req.query.offset as string) ?? '0',   10), 0);
  const type   = req.query.type as string | undefined; // 'app' | 'api' | 'credits'

  try {
    const user = await db.collection('users').findOne({
      $or: [{ wyiUserId }, { linkedProviderIds: wyiUserId }],
    });
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    // Build query — filter by productType hint stored in details._type if present
    const query: Record<string, any> = { userId: user.wyiUserId };
    if (type === 'credits') {
      query['details._type'] = 'api_credits_purchase';
    } else if (type === 'api') {
      query['details._type'] = { $exists: true };
      query['details._type'] = { $in: ['api_plan_event'] }; // extensible
    } else if (type === 'app') {
      query['details._type'] = { $exists: false };
    }

    const [rawLogs, total] = await Promise.all([
      db.collection('payment_logs')
        .find(query)
        .sort({ createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .toArray(),
      db.collection('payment_logs').countDocuments(query),
    ]);

    // ── Enrich each log ────────────────────────────────────────────────────
    const logs = rawLogs.map((log: any) => {
      const details       = log.details ?? {};
      const trial         = extractTrialInfo(details);
      const badge         = statusBadge(details, log.transactionType);
      const productType   = details._type === 'api_credits_purchase'
        ? 'credits'
        : details._type?.startsWith('api_') ? 'api' : 'app';

      return {
        // ── IDs ─────────────────────────────────────────────────────────────
        id:              log._id.toString(),
        subscriptionId:  log.subscriptionId ?? null,
        paddleEventId:   details.event_id   ?? null,

        // ── What happened ────────────────────────────────────────────────────
        type:            log.transactionType,
        product_type:    productType,           // 'app' | 'api' | 'credits'
        label:           labelForEvent(log.transactionType, details),
        product_name:    extractProductName(details),
        billing_cycle:   extractBillingCycle(details),

        // ── Money ────────────────────────────────────────────────────────────
        amount:          formatAmount(details),  // "$3.99" or null
        currency:        details.data?.currency_code ?? null,

        // ── Status badge ─────────────────────────────────────────────────────
        status:          badge.label,
        status_color:    badge.color,

        // ── Trial info ───────────────────────────────────────────────────────
        is_trial:        trial.isTrial,
        trial_ends_at:   trial.trialEndsAt,

        // ── Credits (one-time purchases only) ─────────────────────────────────
        credits_added:   details.creditsAdded ?? null,

        // ── Timestamps ───────────────────────────────────────────────────────
        occurred_at:     details.occurred_at ?? null,   // Paddle's canonical timestamp
        created_at:      log.createdAt,                 // our DB write time (fallback)

        // ── Raw paddle event type ─────────────────────────────────────────────
        paddle_event_type: details.event_type ?? null,
      };
    });

    // ── Aggregate summary ─────────────────────────────────────────────────
    const summary = {
      total_events:         total,
      active_subscription:  logs.some(l => l.status === 'Active' || l.status === 'Trial'),
      total_credits_bought: rawLogs
        .filter(l => l.details?._type === 'api_credits_purchase')
        .reduce((sum: number, l: any) => sum + (l.details?.creditsAdded ?? 0), 0),
      last_payment_at: logs.find(l => l.type === 'subscription_renewed' || l.type === 'subscription_created')?.occurred_at ?? null,
    };

    return res.status(200).json({
      success: true,
      data:    logs,
      summary,
      pagination: {
        total,
        limit,
        offset,
        has_more: offset + limit < total,
      },
    });
  } catch (err) {
    console.error('[getPaymentLogsHandler]', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
}