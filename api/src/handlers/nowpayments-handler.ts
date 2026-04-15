// api/src/handlers/nowpayments-handler.ts
// ─────────────────────────────────────────────────────────────────────────────
//  FIXES:
//    Bug 1 – MongoDB path conflict in handleAppPlanEvent ACTIVATED/PAYMENT_COMPLETED:
//             Removed $unset for 'cryptoSubscription.canceledAt' and
//             'cryptoSubscription.periodEnd' which conflicted with
//             $set: { cryptoSubscription: newDoc } on the same parent path.
//             MongoDB throws "Updating the path 'cryptoSubscription.canceledAt'
//             would create a conflict at 'cryptoSubscription'" causing a 500
//             that silently lost the event (webhook was returning 200).
//    Bug 4 – subscriptionId in handleAppPlanEvent was always undefined.
//             Now uses payload.invoiceId ?? payload.subscriptionId ?? ''.
// ─────────────────────────────────────────────────────────────────────────────

import { Request, Response } from 'express';
import { db }                from '../config/mongo';
import { IPaymentLog }       from '../config/mongo';
import { API_PLANS, ApiPlanName } from '../v1/api-plans';
import { migrateUserEmailsToPro } from '../workers/upgrade-migration';
import { sendEmail }         from '../email/resend';
import { getCancellationEmailHtml, getApiPlanCancellationEmailHtml } from '../email/templates';
import { syncUserFeatures }  from '../workers/feature-sync';
import { client as redis }   from '../config/redis';

// ═════════════════════════════════════════════════════════════════════════════
//  TYPES
// ═════════════════════════════════════════════════════════════════════════════

export interface NowPaymentsEventPayload {
  eventType:             'ACTIVATED' | 'PAYMENT_COMPLETED' | 'PAYMENT_FAILED' | 'REFUNDED' | 'CANCELLED';
  productType?:          'app' | 'api' | 'credits';
  apiPlan?:              ApiPlanName;
  billing?:             'monthly' | 'yearly';
  creditsToAdd?:        number;
  userId?:               string;
  invoiceId?:            string;
  subscriptionId?:       string;
  amount?:               string;
  currency?:             string;
  isCryptoSubscription?: boolean;
  startTime?:            string;
  rawEvent:              any;
}

interface CryptoSubDoc {
  provider:           'nowpayments';
  subscriptionId:     string;
  status:             'ACTIVE' | 'SUSPENDED' | 'PENDING_RENEWAL';
  cancelAtPeriodEnd:  boolean;
  startTime:          string;
  lastUpdated:       Date;
  canceledAt?:        string;
  periodEnd?:         string;
  billingCycle?:      'monthly' | 'yearly';
  isInvoiceBased?:    boolean;
}

// ═════════════════════════════════════════════════════════════════════════════
//  SHARED HELPERS
// ═════════════════════════════════════════════════════════════════════════════

const userQuery = (userId: string) => ({
  $or: [{ wyiUserId: userId }, { linkedProviderIds: userId }],
});

async function findUserByNpSubscriptionId(subscriptionId: string) {
  return db.collection('users').findOne({
    $or: [
      { 'cryptoSubscription.subscriptionId':    subscriptionId },
      { 'apiCryptoSubscription.subscriptionId': subscriptionId },
    ],
  });
}

async function logPaymentEvent(
  userId:          string,
  subscriptionId:  string,
  transactionType: IPaymentLog['transactionType'],
  payload:         NowPaymentsEventPayload,
) {
  await db.collection('payment_logs').insertOne({
    userId,
    transactionType,
    provider:       'nowpayments',
    subscriptionId,
    amount:         payload.amount,
    currency:       payload.currency,
    details:        payload.rawEvent,
    createdAt:      new Date(),
  } as IPaymentLog);
}

const NP_BASE = process.env.NOWPAYMENTS_SANDBOX === 'true'
  ? 'https://api.sandbox.nowpayments.io/v1'
  : 'https://api.nowpayments.io/v1';

async function cancelNpSubscription(subscriptionId: string): Promise<boolean> {
  try {
    const res = await fetch(`${NP_BASE}/subscriptions/${subscriptionId}`, {
      method:  'DELETE',
      headers: { 'x-api-key': process.env.NOWPAYMENTS_API_KEY ?? '' },
    });
    return res.ok || res.status === 404;
  } catch (err) {
    console.error(`[NowPayments] Failed to cancel subscription ${subscriptionId}:`, err);
    return false;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  CREDITS
// ═════════════════════════════════════════════════════════════════════════════

async function handleCreditPurchase(userId: string, payload: NowPaymentsEventPayload) {
  const creditsToAdd = payload.creditsToAdd ?? 0;
  if (creditsToAdd <= 0) {
    console.warn(`[NowPayments] Credits event for ${userId} missing creditsToAdd — skipping.`);
    return;
  }

  const txId     = payload.rawEvent?.payment_id ?? payload.subscriptionId ?? '';
  const idempKey = `credit_tx:np:${txId}`;

  if (await redis.get(idempKey)) {
    console.log(`[NowPayments] Credit tx ${txId} already processed — skipping.`);
    return;
  }

  await db.collection('users').updateOne(userQuery(userId), {
    $inc: { apiCredits: creditsToAdd },
  });
  await redis.set(idempKey, '1', { EX: 90 * 24 * 3600 });

  await db.collection('payment_logs').insertOne({
    userId,
    transactionType: 'subscription_created',
    provider:        'nowpayments',
    subscriptionId:  txId,
    amount:          payload.amount,
    currency:        payload.currency,
    details: {
      ...payload.rawEvent,
      _type:        'api_credits_purchase',
      creditsAdded: creditsToAdd,
    },
    createdAt: new Date(),
  } as IPaymentLog);

  console.log(`[NowPayments] Added ${creditsToAdd} credits to ${userId}. (tx: ${txId})`);
}

// ═════════════════════════════════════════════════════════════════════════════
//  API PLAN
// ═════════════════════════════════════════════════════════════════════════════

async function handleApiPlanEvent(
  eventType: NowPaymentsEventPayload['eventType'],
  userId:    string,
  payload:   NowPaymentsEventPayload,
) {
  const subscriptionId = payload.invoiceId ?? payload.subscriptionId ?? '';
  const apiPlan       = payload.apiPlan ?? 'free';

  switch (eventType) {

    case 'ACTIVATED':
    case 'PAYMENT_COMPLETED': {
      const isRenewal = eventType === 'PAYMENT_COMPLETED';

      const cryptoSubDoc: CryptoSubDoc = {
        provider:           'nowpayments',
        subscriptionId:     subscriptionId,
        status:             'ACTIVE',
        cancelAtPeriodEnd: false,
        startTime:          payload.startTime ?? new Date().toISOString(),
        lastUpdated:       new Date(),
        billingCycle:     payload.billing,
        isInvoiceBased:    payload.isCryptoSubscription ?? false,
      };

      await db.collection('users').updateOne(userQuery(userId), {
        $set: {
          apiPlan,
          apiCryptoSubscription: cryptoSubDoc,
          banStatus: 'none',
          banReason: '',
          banAt:     null,
        },
        $unset: {
          apiScheduledDowngradeAt:   '',
          apiScheduledDowngradePlan: '',
        },
      });

      await logPaymentEvent(
        userId, subscriptionId,
        isRenewal ? 'subscription_renewed' : 'subscription_created',
        payload,
      );
      console.log(`[NowPayments] User ${userId} API plan ${isRenewal ? 'renewed' : 'activated'}: ${apiPlan}`);
      break;
    }

    case 'PAYMENT_FAILED': {
      await db.collection('users').updateOne(userQuery(userId), {
        $set: {
          'apiCryptoSubscription.status':      'SUSPENDED',
          'apiCryptoSubscription.lastUpdated': new Date(),
        },
      });
      console.warn(`[NowPayments] User ${userId} API payment FAILED — subscription SUSPENDED.`);
      break;
    }

    case 'CANCELLED': {
      const periodEnd = payload.rawEvent?.periodEnd ?? new Date().toISOString();

      await db.collection('users').updateOne(userQuery(userId), {
        $set: {
          'apiCryptoSubscription.status':            'ACTIVE',
          'apiCryptoSubscription.cancelAtPeriodEnd': true,
          'apiCryptoSubscription.canceledAt':        new Date().toISOString(),
          'apiCryptoSubscription.periodEnd':         periodEnd,
          'apiCryptoSubscription.lastUpdated':       new Date(),
          apiScheduledDowngradeAt:                   new Date(periodEnd),
        },
      });

      await logPaymentEvent(userId, subscriptionId, 'subscription_cancelled', payload);
      console.log(`[NowPayments] User ${userId} API plan cancelled. Access until ${periodEnd}.`);

      db.collection('users').findOne(userQuery(userId)).then(user => {
        if (!user?.email) return;
        sendEmail({
          to:      user.email,
          from:    'api',
          subject: `Your FreeCustom.Email API ${apiPlan} plan has been cancelled`,
          html:    getApiPlanCancellationEmailHtml(apiPlan, periodEnd),
        }).catch(err => console.error('[NowPayments] API cancel email failed:', err));
      }).catch(() => {});
      break;
    }

    case 'REFUNDED': {
      await logPaymentEvent(userId, subscriptionId, 'refund', payload);
      console.log(`[NowPayments] API refund logged for ${userId}.`);
      break;
    }
  }

  await syncUserFeatures(db, redis, userId);
}

// ═════════════════════════════════════════════════════════════════════════════
//  APP PRO PLAN — FIXED (Bug 1 + Bug 4)
// ═════════════════════════════════════════════════════════════════════════════

async function handleAppPlanEvent(
  eventType: NowPaymentsEventPayload['eventType'],
  userId:    string,
  payload:   NowPaymentsEventPayload,
) {
  // FIX Bug 4: was `payload.subscriptionId!` which is always undefined for
  // invoice-based flows since the webhook never sets subscriptionId.
  const subscriptionId = payload.invoiceId ?? payload.subscriptionId ?? '';

  switch (eventType) {

    case 'ACTIVATED':
    case 'PAYMENT_COMPLETED': {
      const isRenewal = eventType === 'PAYMENT_COMPLETED';
      const subId = payload.invoiceId ?? payload.subscriptionId ?? '';

      const cryptoSubDoc: CryptoSubDoc = {
        provider:           'nowpayments',
        subscriptionId:    subId,
        status:             'ACTIVE',
        cancelAtPeriodEnd: false,
        startTime:         payload.startTime ?? new Date().toISOString(),
        lastUpdated:       new Date(),
        billingCycle:     payload.billing,
        isInvoiceBased:   payload.isCryptoSubscription ?? false,
        // canceledAt and periodEnd intentionally omitted — this is a fresh
        // activation. $set replaces the entire cryptoSubscription document so
        // old cancellation fields are naturally absent.
      };

      const user            = await db.collection('users').findOne(userQuery(userId));
      const actualWyiUserId = user?.wyiUserId ?? userId;

      // FIX Bug 1: REMOVED the $unset for 'cryptoSubscription.canceledAt' and
      // 'cryptoSubscription.periodEnd'. Those lines caused MongoDB to throw:
      //   "Updating the path 'cryptoSubscription.canceledAt' would create a
      //    conflict at 'cryptoSubscription'"
      // because you cannot $set a parent path and $unset a child of that same
      // path in a single update operation. The $set already replaces the whole
      // cryptoSubscription document, so the $unset was redundant AND broken.
      //
      // scheduledDowngradeAt is a separate root field (not a child of
      // cryptoSubscription) so it remains safely in $unset.
      await db.collection('users').updateOne(userQuery(userId), {
        $set: {
          plan:               'pro',
          cryptoSubscription: cryptoSubDoc,
          banStatus:          'none',
          banReason:          '',
          banAt:              null,
        },
        $unset: {
          scheduledDowngradeAt: '',
          // 'cryptoSubscription.canceledAt'  ← REMOVED: conflicts with $set above
          // 'cryptoSubscription.periodEnd'   ← REMOVED: conflicts with $set above
        },
      });

      // ── Pro bonus credits (fingerprint-gated, first activation only) ────────
      if (!isRenewal && !user?.everReceivedProBonusCredits) {
        const userFingerprints = user?.fingerprints ?? [];
        let canGiveBonus = true;

        if (userFingerprints.length > 0) {
          const siblingWithBonus = await db.collection('users').findOne({
            wyiUserId:    { $ne: actualWyiUserId },
            fingerprints: { $in: userFingerprints },
            everReceivedProBonusCredits: true,
          });
          if (siblingWithBonus) {
            canGiveBonus = false;
            console.log(`[NowPayments] User ${actualWyiUserId} denied bonus — sibling already received it.`);
          }
        }

        if (canGiveBonus) {
          await db.collection('users').updateOne(userQuery(userId), {
            $inc: { proBonusCredits: 20000 },
            $set: { receivedProBonusCredits: true, everReceivedProBonusCredits: true },
          });
          console.log(`[NowPayments] Added 20k bonus credits to PRO user ${actualWyiUserId}.`);
        } else {
          await db.collection('users').updateOne(userQuery(userId), {
            $set: { receivedProBonusCredits: true, everReceivedProBonusCredits: true },
          });
        }
      }

      await logPaymentEvent(
        userId, subscriptionId,
        isRenewal ? 'subscription_renewed' : 'subscription_created',
        payload,
      );
      console.log(`[NowPayments] User ${userId} ${isRenewal ? 'renewed' : 'upgraded to'} PRO.`);

      if (!isRenewal) {
        migrateUserEmailsToPro(userId).catch(err =>
          console.error(`[NowPayments] Email migration failed for ${userId}:`, err),
        );
      }
      break;
    }

    case 'PAYMENT_FAILED': {
      await db.collection('users').updateOne(userQuery(userId), {
        $set: {
          'cryptoSubscription.status':      'SUSPENDED',
          'cryptoSubscription.lastUpdated': new Date(),
          apiPlan:         'free',
          proBonusCredits: 0,
        },
        $unset: { receivedProBonusCredits: '' },
      });
      await syncUserFeatures(db, redis, userId);
      console.warn(`[NowPayments] User ${userId} app payment FAILED — subscription SUSPENDED.`);
      break;
    }

    case 'CANCELLED': {
      const periodEnd = payload.rawEvent?.periodEnd ?? new Date().toISOString();

      // Safe: we are dot-notating INTO the existing cryptoSubscription sub-fields,
      // NOT replacing the parent document, so no MongoDB path conflict here.
      await db.collection('users').updateOne(userQuery(userId), {
        $set: {
          'cryptoSubscription.status':            'ACTIVE',
          'cryptoSubscription.cancelAtPeriodEnd': true,
          'cryptoSubscription.canceledAt':        new Date().toISOString(),
          'cryptoSubscription.periodEnd':         periodEnd,
          'cryptoSubscription.lastUpdated':       new Date(),
          scheduledDowngradeAt:                   new Date(periodEnd),
          apiPlan:         'free',
          proBonusCredits: 0,
        },
        $unset: { receivedProBonusCredits: '' },
      });

      await syncUserFeatures(db, redis, userId);
      await logPaymentEvent(userId, subscriptionId, 'subscription_cancelled', payload);
      console.log(`[NowPayments] User ${userId} cancelled. Pro access until ${periodEnd}.`);

      db.collection('users').findOne(userQuery(userId)).then(async user => {
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
        }).catch(err => console.error('[NowPayments] Cancellation email failed:', err));
      }).catch(() => {});
      break;
    }

    case 'REFUNDED': {
      await db.collection('users').updateOne(userQuery(userId), {
        $set: {
          plan:            'free',
          apiPlan:         'free',
          proBonusCredits: 0,
        },
        $unset: { receivedProBonusCredits: '' },
      });
      await syncUserFeatures(db, redis, userId);
      await logPaymentEvent(userId, subscriptionId, 'refund', payload);
      console.log(`[NowPayments] Refund processed for user ${userId}. Plan reverted to free.`);
      break;
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  LINK PENDING SUBSCRIPTION   POST /nowpayments/link
// ═════════════════════════════════════════════════════════════════════════════

export async function linkPendingSubscription(req: Request, res: Response) {
  const { userId, subscriptionId, productType = 'app' } = req.body as {
    userId: string;
    subscriptionId: string;
    productType?: 'app' | 'api';
  };

  if (!userId || !subscriptionId) {
    return res.status(400).json({ success: false, message: 'userId and subscriptionId required' });
  }

  const subField = productType === 'api' ? 'apiCryptoSubscription' : 'cryptoSubscription';
  const q = { $or: [{ wyiUserId: userId }, { linkedProviderIds: userId }] };

  await db.collection('users').updateOne(q, {
    $set: {
      [`${subField}`]: {
        provider:          'nowpayments',
        subscriptionId,
        status:            'PENDING',
        cancelAtPeriodEnd: false,
        startTime:         new Date().toISOString(),
        lastUpdated:       new Date(),
      },
    },
  });

  console.log(`[NowPayments] Linked pending ${productType} sub ${subscriptionId} to user ${userId}`);
  return res.status(200).json({ success: true });
}

// ═════════════════════════════════════════════════════════════════════════════
//  MAIN HANDLER   POST /nowpayments/event
// ═════════════════════════════════════════════════════════════════════════════

export async function handleNowPaymentsEvent(req: Request, res: Response) {
  const payload = req.body as NowPaymentsEventPayload;
  const {
    eventType,
    subscriptionId,
    invoiceId,
    userId: rawUserId,
    productType = 'app',
  } = payload;

  if (!eventType) {
    return res.status(400).json({ success: false, message: 'Missing eventType' });
  }

  let userId = rawUserId;
  const idToCheck = invoiceId ?? subscriptionId;
  if (!userId && idToCheck) {
    const u = await findUserByNpSubscriptionId(idToCheck);
    if (u) userId = u.wyiUserId;
  }

  if (!userId) {
    console.warn(`[NowPayments] Could not resolve userId for invoiceId=${invoiceId} subscriptionId=${subscriptionId}`);
    return res.status(200).json({ success: true, warning: 'User not found, logged as orphan.' });
  }

  try {
    if (productType === 'credits') {
      if (eventType === 'ACTIVATED' || eventType === 'PAYMENT_COMPLETED') {
        await handleCreditPurchase(userId, payload);
      }
      return res.status(200).json({ success: true });
    }

    if (productType === 'api') {
      await handleApiPlanEvent(eventType, userId, payload);
      return res.status(200).json({ success: true });
    }

    await handleAppPlanEvent(eventType, userId, payload);
    return res.status(200).json({ success: true });

  } catch (error) {
    console.error(`[NowPayments] Error handling ${eventType} for ${userId}:`, error);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  PLAN CHANGE HANDLER   POST /nowpayments/change-plan
// ═════════════════════════════════════════════════════════════════════════════

const PLAN_ORDER: ApiPlanName[] = ['free', 'developer', 'startup', 'growth', 'enterprise'];

function npPlanChangeType(from: string, to: ApiPlanName): 'upgrade' | 'downgrade' | 'same' {
  const fromIdx = PLAN_ORDER.indexOf(from as ApiPlanName);
  const toIdx   = PLAN_ORDER.indexOf(to);
  if (toIdx > fromIdx) return 'upgrade';
  if (toIdx < fromIdx) return 'downgrade';
  return 'same';
}

export async function changeNowPaymentsPlanHandler(req: Request, res: Response): Promise<any> {
  const {
    userId: rawUserId,
    targetPlan,
    productType = 'api',
    reason,
    comment,
  } = req.body as {
    userId?:      string;
    targetPlan?:  ApiPlanName;
    productType?: 'app' | 'api';
    reason?:      string;
    comment?:     string;
  };

  if (!rawUserId || !targetPlan) {
    return res.status(400).json({ success: false, message: 'userId and targetPlan are required.' });
  }
  if (productType === 'api' && !API_PLANS[targetPlan]) {
    return res.status(400).json({ success: false, message: `Unknown plan: ${targetPlan}` });
  }
  if (targetPlan === 'free') {
    return res.status(400).json({
      success: false,
      message: 'To cancel to free, use the subscription cancellation flow instead.',
    });
  }

  const user = await db.collection('users').findOne({
    $or: [{ wyiUserId: rawUserId }, { linkedProviderIds: rawUserId }],
  });
  if (!user) {
    return res.status(404).json({ success: false, message: 'User not found.' });
  }

  const subField    = productType === 'api' ? 'apiCryptoSubscription' : 'cryptoSubscription';
  const currentPlan = productType === 'api'
    ? (user.apiPlan as string ?? 'free')
    : (user.plan === 'pro' ? 'pro' : 'free');

  const sub = user[subField] as (CryptoSubDoc & Record<string, any>) | undefined;

  if (!sub?.subscriptionId || sub.provider !== 'nowpayments') {
    return res.status(400).json({
      success: false,
      message:  'No active NOWPayments subscription found. Please subscribe first.',
      code:     'NO_NP_SUBSCRIPTION',
    });
  }
  if (sub.status === 'SUSPENDED') {
    return res.status(400).json({
      success: false,
      message: 'Subscription is suspended due to a failed payment. Please resubscribe.',
    });
  }

  const changeType = npPlanChangeType(currentPlan, targetPlan);
  if (changeType === 'same') {
    return res.status(400).json({ success: false, message: 'You are already on this plan.' });
  }

  const cancelled = await cancelNpSubscription(sub.subscriptionId);
  if (!cancelled) {
    return res.status(502).json({
      success: false,
      message:  'Failed to cancel existing NOWPayments subscription. Please try again.',
    });
  }
  console.log(
    `[NowPayments] Cancelled subscription ${sub.subscriptionId} for ${rawUserId} (${changeType}: ${currentPlan} → ${targetPlan}).`,
  );

  const q = { $or: [{ wyiUserId: rawUserId }, { linkedProviderIds: rawUserId }] };

  if (changeType === 'upgrade') {
    await db.collection('users').updateOne(q, {
      $set: {
        ...(productType === 'api'
          ? { apiPlan: targetPlan }
          : { plan:   'pro'      }
        ),
        [`${subField}.status`]:            'PENDING_RENEWAL',
        [`${subField}.cancelAtPeriodEnd`]: false,
        [`${subField}.lastUpdated`]:       new Date(),
      },
      $unset: {
        apiScheduledDowngradeAt:   '',
        apiScheduledDowngradePlan: '',
        scheduledDowngradeAt:      '',
        [`${subField}.canceledAt`]: '',
        [`${subField}.periodEnd`]:  '',
      },
    });

    await syncUserFeatures(db, redis, rawUserId);

    if (reason) {
      db.collection('plan_change_reasons').insertOne({
        userId: user.wyiUserId, fromPlan: currentPlan, toPlan: targetPlan,
        changeType: 'upgrade', provider: 'nowpayments', reason, comment: comment ?? null,
        createdAt: new Date(),
      }).catch(() => {});
    }

    return res.status(200).json({
      success:             true,
      changeType:          'upgrade',
      fromPlan:            currentPlan,
      toPlan:              targetPlan,
      requiresNewCheckout: true,
      message:             `Upgrading to ${targetPlan}. Please complete the new checkout to confirm.`,
    });
  }

  // DOWNGRADE
  const periodEnd =
    sub.periodEnd
    ?? sub.nextBilledAt
    ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  await db.collection('users').updateOne(q, {
    $set: {
      [`${subField}.cancelAtPeriodEnd`]: true,
      [`${subField}.canceledAt`]:        new Date().toISOString(),
      [`${subField}.periodEnd`]:         periodEnd,
      [`${subField}.lastUpdated`]:       new Date(),
      ...(productType === 'api'
        ? {
            apiScheduledDowngradeAt:   new Date(periodEnd),
            apiScheduledDowngradePlan: targetPlan,
          }
        : {
            scheduledDowngradeAt: new Date(periodEnd),
          }
      ),
    },
  });

  await syncUserFeatures(db, redis, rawUserId);

  if (reason) {
    db.collection('plan_change_reasons').insertOne({
      userId: user.wyiUserId, fromPlan: currentPlan, toPlan: targetPlan,
      changeType: 'downgrade', provider: 'nowpayments', reason, comment: comment ?? null,
      createdAt: new Date(),
    }).catch(() => {});
  }

  console.log(`[NowPayments] ${rawUserId}: downgrade ${currentPlan} → ${targetPlan} — access until ${periodEnd}.`);

  return res.status(200).json({
    success:             true,
    changeType:          'downgrade',
    fromPlan:            currentPlan,
    toPlan:              targetPlan,
    effectiveAt:         periodEnd,
    requiresNewCheckout: false,
    message: `Your plan will change to ${targetPlan} on ${new Date(periodEnd).toLocaleDateString()}.`,
  });
}