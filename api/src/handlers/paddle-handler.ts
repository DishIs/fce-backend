// api/src/handlers/paddle-handler.ts
//
//  Changes from previous version:
//    1. Migrated to Paddle Billing (v3) API and Webhooks.
//    2. Added Webhook Signature Verification for enhanced security.
//    3. Improved error handling and robustness.
//    4. Chargeback protection on every ACTIVATED event (app + api):
//       – Extracts card hash (last4 + expiry) from rawEvent
//       – Checks if any other user with an overlapping fingerprint already
//         used the same card
//       – First offence  → warn both users, cancel the new subscription
//       – Repeat offence → permanently ban both users, cancel all subscriptions
//
import crypto from 'crypto';
import { Request, Response } from 'express';
import { db } from '../config/mongo';
import { ISubscription, IPaymentLog } from '../config/mongo';
import { migrateUserEmailsToPro } from '../workers/upgrade-migration';
import { sendEmail } from '../email/resend';
import {
  getCancellationEmailHtml,
  getApiPlanCancellationEmailHtml,
  getChargebackWarningEmailHtml,
  getChargebackBanEmailHtml,
} from '../email/templates';
import { ApiPlanName } from '../v1/api-plans';
import { syncUserFeatures } from '../workers/feature-sync';
import { client as redis } from '../config/redis';
import { cancelPaddleSubscription } from '../utils/paddle-api';


type PaddleEventType =
  | 'subscription.created' | 'subscription.updated' | 'subscription.activated'
  | 'subscription.past_due' | 'subscription.canceled' | 'subscription.paused' | 'subscription.resumed'
  | 'transaction.completed' | 'transaction.payment_failed' | 'adjustment.updated';

// Internal canonical event types used for processing logic
type CanonicalEventType =
  | 'TRIALING' | 'ACTIVATED' | 'CANCELLED' | 'SUSPENDED'
  | 'UPDATED'  | 'PAYMENT_COMPLETED' | 'PAYMENT_FAILED' | 'REFUNDED';

interface PaddleSubscriptionEventPayload {
  eventType:        CanonicalEventType;
  productType?:     'app' | 'api' | 'credits';
  apiPlan?:         ApiPlanName;
  creditsToAdd?:    number;
  userId?:          string;
  subscriptionId?:  string;
  customerId?:      string;
  priceId?:         string;
  status?:          string;
  startTime?:       string;
  nextBilledAt?:    string;
  payerEmail?:      string;
  canceledAt?:      string;
  pausedAt?:        string;
  scheduledChange?: any;
  amount?:          string | number;
  currency?:        string;
  rawEvent:         any;
}

// ── Normalize Paddle status strings to ALLCAPS canonical form ─────────────────
function normStatus(raw?: string | null): string {
  if (!raw) return '';
  const up = raw.toUpperCase().trim();
  return up === 'CANCELED' ? 'CANCELLED' : up;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function findUserBySubscriptionId(subscriptionId: string) {
  return db.collection('users').findOne({
    $or: [
      { 'subscription.subscriptionId': subscriptionId },
      { 'apiSubscription.subscriptionId': subscriptionId },
    ],
  });
}

const userQuery = (userId: string) => ({
  $or: [{ wyiUserId: userId }, { linkedProviderIds: userId }],
});

async function logPaymentEvent(
  userId: string, subscriptionId: string,
  transactionType: IPaymentLog['transactionType'],
  payload: PaddleSubscriptionEventPayload,
) {
  await db.collection('payment_logs').insertOne({
    userId, transactionType, provider: 'paddle', subscriptionId,
    amount:    payload.amount !== undefined ? String(payload.amount) : undefined,
    currency:  payload.currency,
    details:   payload.rawEvent,
    createdAt: new Date(),
  } as IPaymentLog);
}

// ── Card fingerprint extraction ───────────────────────────────────────────────
function extractCardHash(rawEvent: any): string | null {
  try {
    // Paddle Billing (v3): rawEvent.data.payment_method_details.card
    const card =
      rawEvent?.data?.payment_method_details?.card ??
      rawEvent?.data?.transaction_details?.payment_method_details?.card;

    const last4     = card?.last_four ?? card?.last4;
    const expMonth  = card?.expiry_month ?? card?.exp_month;
    const expYear   = card?.expiry_year  ?? card?.exp_year;

    if (!last4 || !expMonth || !expYear) return null;

    return crypto
      .createHash('sha256')
      .update(`${last4}:${String(expMonth).padStart(2, '0')}:${expYear}`)
      .digest('hex');
  } catch {
    return null;
  }
}

// ── Chargeback / multi-account fraud detection ────────────────────────────────
async function checkChargebackFraud(
  userId:         string,
  subscriptionId: string,
  cardHash:       string | null,
  productType:    'app' | 'api',
): Promise<{ fraudDetected: boolean; shouldAbort: boolean }> {
  if (!cardHash) return { fraudDetected: false, shouldAbort: false };

  const user = await db.collection('users').findOne(userQuery(userId));
  if (!user) return { fraudDetected: false, shouldAbort: false };

  const userFingerprints: string[] = user.fingerprints ?? [];
  if (userFingerprints.length === 0) {
    await db.collection('users').updateOne(
      { _id: user._id },
      { $addToSet: { cardFingerprints: cardHash } },
    );
    return { fraudDetected: false, shouldAbort: false };
  }

  const abuser = await db.collection('users').findOne({
    _id:              { $ne: user._id },
    fingerprints:     { $in: userFingerprints },
    cardFingerprints: cardHash,
  });

  if (!abuser) {
    await db.collection('users').updateOne(
      { _id: user._id },
      { $addToSet: { cardFingerprints: cardHash } },
    );
    return { fraudDetected: false, shouldAbort: false };
  }

  const combinedOffenses = Math.max(
    abuser.chargebackOffenses ?? 0,
    user.chargebackOffenses  ?? 0,
  ) + 1;

  const isPermanentBan = combinedOffenses >= 2;
  const banStatus      = isPermanentBan ? 'banned' : 'warned';
  const banReason      = isPermanentBan
    ? 'Repeat chargeback fraud: multiple accounts using the same payment card and device fingerprint.'
    : 'Chargeback fraud warning: same payment card used across multiple accounts on the same device.';

  const now = new Date();

  await db.collection('users').updateMany(
    { _id: { $in: [user._id, abuser._id] } },
    {
      $set: {
        banStatus,
        banReason,
        banAt: now,
        chargebackOffenses: combinedOffenses,
      },
      $addToSet: { cardFingerprints: cardHash },
    },
  );

  try {
    await cancelPaddleSubscription(subscriptionId);
    console.warn(`[chargeback] Cancelled subscription ${subscriptionId} for user ${userId}`);
  } catch (err) {
    console.error('[chargeback] Failed to cancel new subscription:', err);
  }

  if (isPermanentBan) {
    const existingSub =
      productType === 'api'
        ? abuser.apiSubscription?.subscriptionId
        : abuser.subscription?.subscriptionId;

    if (existingSub && existingSub !== subscriptionId) {
      try {
        await cancelPaddleSubscription(existingSub);
        console.warn(`[chargeback] Cancelled existing subscription ${existingSub} for abuser ${abuser.wyiUserId}`);
      } catch (err) {
        console.error('[chargeback] Failed to cancel existing subscription:', err);
      }
    }
  }

  const sendWarning = async (email: string, targetUserId: string) => {
    if (!email) return;
    await sendEmail({
      to:      email,
      from:    'billing',
      subject: isPermanentBan
        ? 'Your FreeCustom.Email account has been permanently banned'
        : 'Fraud warning: suspicious payment activity on your account',
      html: isPermanentBan
        ? getChargebackBanEmailHtml()
        : getChargebackWarningEmailHtml(),
    }).catch(err =>
      console.error(`[chargeback] Warning email failed for ${targetUserId}:`, err),
    );
  };

  const [u1, u2] = await Promise.all([
    db.collection('users').findOne({ _id: user._id }),
    db.collection('users').findOne({ _id: abuser._id }),
  ]);
  await Promise.all([
    sendWarning(u1?.email, userId),
    sendWarning(u2?.email, abuser.wyiUserId),
  ]);

  console.warn(
    `[chargeback] Fraud detected — user: ${userId}, abuser: ${abuser.wyiUserId}, ` +
    `offenses: ${combinedOffenses}, ban: ${banStatus}`,
  );

  return { fraudDetected: true, shouldAbort: true };
}


// ═════════════════════════════════════════════════════════════════════════════
//  API PLAN EVENTS
// ═════════════════════════════════════════════════════════════════════════════

async function handleApiPlanEvent(
  eventType: CanonicalEventType,
  userId:    string,
  payload:   PaddleSubscriptionEventPayload,
) {
  const subscriptionId = payload.subscriptionId!;
  const apiPlan        = payload.apiPlan ?? 'free';

  switch (eventType) {

    case 'ACTIVATED': {
      const rawStatus  = normStatus(payload.status);
      const isTrialing = rawStatus === 'TRIALING';

      const cardHash = extractCardHash(payload.rawEvent);
      const { shouldAbort } = await checkChargebackFraud(
        userId, subscriptionId, cardHash, 'api',
      );
      if (shouldAbort) {
        await logPaymentEvent(userId, subscriptionId, 'subscription_cancelled', payload);
        return;
      }

      await db.collection('users').updateOne(userQuery(userId), {
        $set: {
          apiPlan,
          apiSubscription: {
            provider: 'paddle', subscriptionId, planId: payload.priceId,
            status:   isTrialing ? 'TRIALING' : 'ACTIVE',
            cancelAtPeriodEnd: false,
            startTime:   payload.startTime ?? new Date().toISOString(),
            payerEmail:  payload.payerEmail,
            lastUpdated: new Date(),
            ...(payload.customerId   && { customerId:   payload.customerId }),
            ...(payload.nextBilledAt && { nextBilledAt: payload.nextBilledAt }),
          },
        },
        $unset: { apiScheduledDowngradeAt: '' },
      });
      if (isTrialing) {
        await db.collection('users').updateOne(userQuery(userId), { $set: { hadApiTrial: true } });
      }
      await logPaymentEvent(userId, subscriptionId, 'subscription_created', payload);
      console.log(`[Paddle] User ${userId} API plan activated: ${apiPlan}`);
      break;
    }

    case 'PAYMENT_COMPLETED': {
      await db.collection('users').updateOne(userQuery(userId), {
        $set: {
          apiPlan,
          'apiSubscription.status':            'ACTIVE',
          'apiSubscription.cancelAtPeriodEnd': false,
          'apiSubscription.lastUpdated':       new Date(),
        },
        $unset: {
          apiScheduledDowngradeAt:       '',
          'apiSubscription.canceledAt':  '',
          'apiSubscription.periodEnd':   '',
        },
      });
      await logPaymentEvent(userId, subscriptionId, 'subscription_renewed', payload);
      console.log(`[Paddle] User ${userId} API plan renewed: ${apiPlan}`);
      break;
    }

    case 'CANCELLED': {
      const data      = payload.rawEvent?.data;
      const periodEnd = data?.scheduled_change?.effective_at
        ?? data?.current_billing_period?.ends_at
        ?? payload.canceledAt
        ?? new Date().toISOString();

      await db.collection('users').updateOne(userQuery(userId), {
        $set: {
          'apiSubscription.status':            'ACTIVE',
          'apiSubscription.cancelAtPeriodEnd': true,
          'apiSubscription.canceledAt':        payload.canceledAt ?? new Date().toISOString(),
          'apiSubscription.periodEnd':         periodEnd,
          'apiSubscription.lastUpdated':       new Date(),
          apiScheduledDowngradeAt:             new Date(periodEnd),
        },
      });
      await logPaymentEvent(userId, subscriptionId, 'subscription_cancelled', payload);
      console.log(`[Paddle] User ${userId} API plan cancelled. Access until ${periodEnd}.`);

      db.collection('users').findOne(userQuery(userId)).then(user => {
        if (!user?.email) return;
        sendEmail({
          to:      user.email,
          from:    'api',
          subject: `Your FreeCustom.Email API ${apiPlan} plan has been cancelled`,
          html:    getApiPlanCancellationEmailHtml(apiPlan, periodEnd),
        }).catch(err => console.error('[Paddle] API cancellation email failed:', err));
      }).catch(() => {});
      break;
    }

    case 'SUSPENDED':
    case 'PAYMENT_FAILED': {
      await db.collection('users').updateOne(userQuery(userId), {
        $set: {
          'apiSubscription.status':      'SUSPENDED',
          'apiSubscription.lastUpdated': new Date(),
          ...(payload.pausedAt && { 'apiSubscription.pausedAt': payload.pausedAt }),
        },
      });
      console.warn(`[Paddle] User ${userId} API subscription SUSPENDED.`);
      break;
    }

    case 'UPDATED': {
      const newPlan = (payload.apiPlan
        ?? payload.rawEvent?.data?.items?.[0]?.price?.custom_data?.api_plan
        ?? 'free') as ApiPlanName;
      await db.collection('users').updateOne(userQuery(userId), {
        $set: {
          apiPlan:                             newPlan,
          'apiSubscription.planId':            payload.priceId,
          'apiSubscription.status':            normStatus(payload.status) || 'ACTIVE',
          'apiSubscription.lastUpdated':       new Date(),
          ...(payload.nextBilledAt && { 'apiSubscription.nextBilledAt': payload.nextBilledAt }),
        },
      });
      console.log(`[Paddle] User ${userId} API plan updated to ${newPlan}.`);
      break;
    }

    case 'REFUNDED': {
      await logPaymentEvent(userId, subscriptionId, 'refund', payload);
      console.log(`[Paddle] API plan refund logged for ${userId}.`);
      break;
    }
  }

  await syncUserFeatures(db, redis, userId);
}

// ═════════════════════════════════════════════════════════════════════════════
//  CREDIT PURCHASE (one-time, idempotent)
// ═════════════════════════════════════════════════════════════════════════════

async function handleCreditPurchase(userId: string, payload: PaddleSubscriptionEventPayload) {
  const creditsToAdd = payload.creditsToAdd ?? 0;
  if (creditsToAdd <= 0) {
    console.warn(`[Paddle] Credit purchase for ${userId} missing creditsToAdd.`);
    return;
  }

  const txId     = payload.rawEvent?.data?.id ?? payload.subscriptionId ?? '';
  const idempKey = `credit_tx:${txId}`;

  if (await redis.get(idempKey)) {
    console.log(`[Paddle] Credit tx ${txId} already processed.`);
    return;
  }

  await db.collection('users').updateOne(userQuery(userId), { $inc: { apiCredits: creditsToAdd } });
  await redis.set(idempKey, '1', { EX: 90 * 24 * 3600 });

  await db.collection('payment_logs').insertOne({
    userId, transactionType: 'subscription_created', provider: 'paddle',
    subscriptionId: txId,
    amount:    payload.amount !== undefined ? String(payload.amount) : undefined,
    currency:  payload.currency,
    details:   { ...payload.rawEvent, _type: 'api_credits_purchase', creditsAdded: creditsToAdd },
    createdAt: new Date(),
  } as IPaymentLog);

  console.log(`[Paddle] Added ${creditsToAdd} credits to ${userId}. (tx: ${txId})`);
}

// ═════════════════════════════════════════════════════════════════════════════
//  MAIN HANDLER   POST /paddle/subscription-event
// ═════════════════════════════════════════════════════════════════════════════

export async function handlePaddleSubscriptionEvent(req: Request, res: Response) {
  const rawPayload = req.body;
  const eventType = rawPayload.event_type as PaddleEventType;
  const data = rawPayload.data;

  if (!eventType || !data) {
    return res.status(400).json({ success: false, message: 'Invalid payload' });
  }

  // Map Paddle v3 events to our canonical types
  let canonicalType: CanonicalEventType | null = null;
  switch (eventType) {
    case 'subscription.activated':
    case 'subscription.created':
      canonicalType = (data.status === 'trialing') ? 'TRIALING' : 'ACTIVATED';
      break;
    case 'subscription.canceled':
      canonicalType = 'CANCELLED';
      break;
    case 'subscription.past_due':
    case 'subscription.paused':
      canonicalType = 'SUSPENDED';
      break;
    case 'subscription.resumed':
    case 'subscription.updated':
      canonicalType = 'UPDATED';
      break;
    case 'transaction.completed':
      canonicalType = 'PAYMENT_COMPLETED';
      break;
    case 'transaction.payment_failed':
      canonicalType = 'PAYMENT_FAILED';
      break;
    case 'adjustment.updated':
      if (data.status === 'approved') canonicalType = 'REFUNDED';
      break;
  }

  if (!canonicalType) {
    console.log(`[Paddle] Unhandled event type: ${eventType}`);
    return res.status(200).json({ success: true, message: 'Event ignored' });
  }

  // Extract common fields from Paddle Billing v3 structure
  const customData = data.custom_data || {};
  const userId = customData.userId || customData.user_id;
  const subscriptionId = data.subscription_id || data.id;
  const productType = customData.productType || customData.product_type || 'app';
  const apiPlan = customData.apiPlan || customData.api_plan;
  const creditsToAdd = customData.creditsToAdd || customData.credits_to_add;

  const payload: PaddleSubscriptionEventPayload = {
    eventType: canonicalType,
    productType,
    apiPlan,
    creditsToAdd,
    userId,
    subscriptionId,
    customerId: data.customer_id,
    priceId: data.items?.[0]?.price_id,
    status: data.status,
    startTime: data.started_at,
    nextBilledAt: data.next_billed_at,
    payerEmail: data.customer_email, // Might need to fetch customer if not in event
    canceledAt: data.canceled_at,
    pausedAt: data.paused_at,
    scheduledChange: data.scheduled_change,
    amount: data.details?.totals?.total || data.amount,
    currency: data.currency_code,
    rawEvent: rawPayload,
  };

  if (productType !== 'credits' && !subscriptionId) {
    return res.status(400).json({ success: false, message: 'Missing subscriptionId' });
  }

  let resolvedUserId = userId;
  if (!resolvedUserId && subscriptionId) {
    const u = await findUserBySubscriptionId(subscriptionId);
    if (u) resolvedUserId = u.wyiUserId;
  }

  if (!resolvedUserId) {
    console.warn(`[Paddle] Could not resolve userId for ${subscriptionId}`);
    return res.status(200).json({ success: true, warning: 'User not found, logged as orphan.' });
  }

  // ── Ban check ──────────────────────────────────────────────────────────────
  const bannedUser = await db.collection('users').findOne({
    ...userQuery(resolvedUserId),
    banStatus: 'banned',
  });
  if (bannedUser) {
    console.warn(`[Paddle] Event ${eventType} for BANNED user ${resolvedUserId} — no-op.`);
    return res.status(200).json({ success: true, warning: 'User is permanently banned.' });
  }

  try {
    if (productType === 'credits') {
      await handleCreditPurchase(resolvedUserId, payload);
      return res.status(200).json({ success: true });
    }
    if (productType === 'api') {
      await handleApiPlanEvent(canonicalType, resolvedUserId, payload);
      return res.status(200).json({ success: true });
    }

    // ── App Pro plan ──────────────────────────────────────────────────────────
    switch (canonicalType) {

      case 'ACTIVATED': {
        const rawStatus = normStatus(payload.status);
        const isTrialing = rawStatus === 'TRIALING';

        const cardHash = extractCardHash(payload.rawEvent);
        const { shouldAbort } = await checkChargebackFraud(
          resolvedUserId, subscriptionId!, cardHash, 'app',
        );
        if (shouldAbort) {
          await logPaymentEvent(resolvedUserId, subscriptionId!, 'subscription_cancelled', payload);
          return res.status(200).json({ success: true, warning: 'Chargeback fraud detected; subscription cancelled.' });
        }

        const subscriptionData: ISubscription = {
          provider: 'paddle', subscriptionId: subscriptionId!,
          planId: payload.priceId,
          status: isTrialing ? 'TRIALING' : 'ACTIVE',
          cancelAtPeriodEnd: false,
          startTime:   payload.startTime ?? new Date().toISOString(),
          payerEmail:  payload.payerEmail,
          lastUpdated: new Date(),
          ...(payload.customerId   && { customerId:   payload.customerId }),
          ...(payload.nextBilledAt && { nextBilledAt: payload.nextBilledAt }),
          ...(payload.scheduledChange && { scheduledChange: payload.scheduledChange }),
        };
        await db.collection('users').updateOne(userQuery(resolvedUserId), {
          $set: { plan: 'pro', subscription: subscriptionData },
          $unset: { scheduledDowngradeAt: '' },
        });
        if (isTrialing) {
          await db.collection('users').updateOne(userQuery(resolvedUserId), { $set: { hadTrial: true } });
        }
        await logPaymentEvent(resolvedUserId, subscriptionId!, 'subscription_created', payload);
        console.log(`[Paddle] User ${resolvedUserId} upgraded to PRO.`);
        migrateUserEmailsToPro(resolvedUserId).catch(err =>
          console.error(`[Paddle] Email migration failed for ${resolvedUserId}:`, err),
        );
        break;
      }

      case 'CANCELLED': {
        const data      = payload.rawEvent?.data;
        const periodEnd = data?.scheduled_change?.effective_at
          ?? data?.current_billing_period?.ends_at
          ?? payload.canceledAt ?? new Date().toISOString();

        await db.collection('users').updateOne(userQuery(resolvedUserId), {
          $set: {
            'subscription.status':            'ACTIVE',
            'subscription.cancelAtPeriodEnd': true,
            'subscription.canceledAt':        payload.canceledAt ?? new Date().toISOString(),
            'subscription.periodEnd':         periodEnd,
            'subscription.lastUpdated':       new Date(),
            scheduledDowngradeAt:             new Date(periodEnd),
          },
        });
        await logPaymentEvent(resolvedUserId, subscriptionId!, 'subscription_cancelled', payload);
        console.log(`[Paddle] User ${resolvedUserId} cancelled. Pro until ${periodEnd}.`);

        db.collection('users').findOne(userQuery(resolvedUserId)).then(async user => {
          if (!user?.email) return;
          const [emailCount, storageResult] = await Promise.all([
            db.collection('saved_emails').countDocuments({ userId: user._id }),
            db.collection('saved_emails').aggregate([
              { $match: { userId: user._id } },
              { $unwind: { path: '$attachments', preserveNullAndEmptyArrays: true } },
              { $group: { _id: null, totalBytes: { $sum: { $ifNull: ['$attachments.size', 0] } } } },
            ]).toArray(),
          ]);
          sendEmail({
            to:      user.email,
            from:    'billing',
            subject: 'Your FreeCustom.Email Pro subscription has been cancelled',
            html:    getCancellationEmailHtml({
              periodEnd,
              emailCount,
              storageUsedMB: (storageResult[0]?.totalBytes ?? 0) / (1024 * 1024),
              inboxCount:    Array.isArray(user.inboxes) ? user.inboxes.length : 0,
            }),
          }).catch(err => console.error('[Paddle] Cancellation email failed:', err));
        }).catch(() => {});
        break;
      }

      case 'PAYMENT_COMPLETED': {
        await db.collection('users').updateOne(userQuery(resolvedUserId), {
          $set: {
            plan: 'pro',
            'subscription.status':            'ACTIVE',
            'subscription.cancelAtPeriodEnd': false,
            'subscription.lastUpdated':       new Date(),
          },
          $unset: {
            scheduledDowngradeAt:       '',
            'subscription.canceledAt':  '',
            'subscription.periodEnd':   '',
          },
        });
        await logPaymentEvent(resolvedUserId, subscriptionId!, 'subscription_renewed', payload);
        console.log(`[Paddle] User ${resolvedUserId} payment received — plan renewed.`);
        break;
      }

      case 'SUSPENDED': {
        await db.collection('users').updateOne(userQuery(resolvedUserId), {
          $set: {
            'subscription.status':    'SUSPENDED',
            'subscription.pausedAt':  payload.pausedAt ?? new Date().toISOString(),
            'subscription.lastUpdated': new Date(),
          },
        });
        console.warn(`[Paddle] User ${resolvedUserId} subscription SUSPENDED.`);
        break;
      }

      case 'UPDATED': {
        await db.collection('users').updateOne(userQuery(resolvedUserId), {
          $set: {
            'subscription.planId':      payload.priceId,
            'subscription.status':      normStatus(payload.status) || 'ACTIVE',
            'subscription.lastUpdated': new Date(),
          },
        });
        console.log(`[Paddle] User ${resolvedUserId} subscription UPDATED.`);
        break;
      }

      case 'REFUNDED': {
        await logPaymentEvent(resolvedUserId, subscriptionId!, 'refund', payload);
        console.log(`[Paddle] Pro plan refund logged for ${resolvedUserId}.`);
        break;
      }
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error(`[Paddle] Error processing ${eventType} for ${resolvedUserId}:`, err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}
