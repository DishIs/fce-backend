// api/src/handlers/nowpayments-handler.ts
// ─────────────────────────────────────────────────────────────────────────────
//  Handles all NOWPayments IPN events forwarded from the Next.js webhook route.
//  Parallel to paddle-handler.ts — same DB fields, same syncUserFeatures logic.
//
//  HOW IT DIFFERS FROM PADDLE:
//  • No trials (NOWPayments doesn't support trial periods).
//  • Crypto subscriptions are stored under user.cryptoSubscription (app) and
//    user.apiCryptoSubscription (API) — completely separate from the Paddle
//    fields (user.subscription / user.apiSubscription), so both providers can
//    coexist on the same user document without clobbering each other.
//  • The effective plan fields (user.plan, user.apiPlan) are shared — whichever
//    provider is active writes to them. syncUserFeatures() resolves the truth.
//  • Upgrade/downgrade has no Paddle-style PATCH API. See changeNowPaymentsPlanHandler.
//
//  EVENT FLOW (what the NP webhook sends us):
//    NP "confirmed"  → ACTIVATED       (early unlock on blockchain confirm)
//    NP "sending"    → ACTIVATED       (same — funds en route to our wallet)
//    NP "finished"   → PAYMENT_COMPLETED (fully settled — canonical renewal)
//    NP "failed"     → PAYMENT_FAILED
//    NP "expired"    → PAYMENT_FAILED
//    NP "refunded"   → REFUNDED
//    (CANCELLED is only sent by our own change-plan handler for explicit cancels)
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
  eventType:       'ACTIVATED' | 'PAYMENT_COMPLETED' | 'PAYMENT_FAILED' | 'REFUNDED' | 'CANCELLED';
  productType?:    'app' | 'api' | 'credits';
  apiPlan?:        ApiPlanName;
  creditsToAdd?:   number;
  userId?:         string;
  subscriptionId?: string;   // NP subscription_id (recurring) or payment_id (invoice)
  amount?:         string;
  currency?:       string;
  startTime?:      string;
  rawEvent:        any;
}

// Shape stored under user.cryptoSubscription / user.apiCryptoSubscription
interface CryptoSubDoc {
  provider:          'nowpayments';
  subscriptionId:    string;
  status:            'ACTIVE' | 'SUSPENDED' | 'PENDING_RENEWAL';
  cancelAtPeriodEnd: boolean;
  startTime:         string;
  lastUpdated:       Date;
  canceledAt?:       string;
  periodEnd?:        string;
}

// ═════════════════════════════════════════════════════════════════════════════
//  SHARED HELPERS
// ═════════════════════════════════════════════════════════════════════════════

const userQuery = (userId: string) => ({
  $or: [{ wyiUserId: userId }, { linkedProviderIds: userId }],
});

/** Lookup by NP subscriptionId for IPN events where userId may be missing. */
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

// ── NOWPayments REST helpers ──────────────────────────────────────────────────

const NP_BASE = process.env.NOWPAYMENTS_SANDBOX === 'true'
  ? 'https://api.sandbox.nowpayments.io/v1'
  : 'https://api.nowpayments.io/v1';

async function cancelNpSubscription(subscriptionId: string): Promise<boolean> {
  try {
    const res = await fetch(`${NP_BASE}/subscriptions/${subscriptionId}`, {
      method:  'DELETE',
      headers: { 'x-api-key': process.env.NOWPAYMENTS_API_KEY ?? '' },
    });
    // 404 = already cancelled — treat as success so plan changes aren't blocked
    return res.ok || res.status === 404;
  } catch (err) {
    console.error(`[NowPayments] Failed to cancel subscription ${subscriptionId}:`, err);
    return false;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  CREDITS  (productType === 'credits')
// ═════════════════════════════════════════════════════════════════════════════

async function handleCreditPurchase(userId: string, payload: NowPaymentsEventPayload) {
  const creditsToAdd = payload.creditsToAdd ?? 0;
  if (creditsToAdd <= 0) {
    console.warn(`[NowPayments] Credits event for ${userId} missing creditsToAdd — skipping.`);
    return;
  }

  // Idempotency: NP can fire ACTIVATED then PAYMENT_COMPLETED for the same tx.
  // Use NP payment_id as the key, namespaced 'np:' to avoid collision with Paddle keys.
  const txId     = payload.rawEvent?.payment_id ?? payload.subscriptionId ?? '';
  const idempKey = `credit_tx:np:${txId}`;

  if (await redis.get(idempKey)) {
    console.log(`[NowPayments] Credit tx ${txId} already processed — skipping.`);
    return;
  }

  await db.collection('users').updateOne(userQuery(userId), {
    $inc: { apiCredits: creditsToAdd },
  });
  // Keep idempotency key for 90 days (same as Paddle)
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
//  API PLAN  (productType === 'api')
// ═════════════════════════════════════════════════════════════════════════════

async function handleApiPlanEvent(
  eventType: NowPaymentsEventPayload['eventType'],
  userId:    string,
  payload:   NowPaymentsEventPayload,
) {
  const subscriptionId = payload.subscriptionId!;
  const apiPlan        = payload.apiPlan ?? 'free';

  switch (eventType) {

    // ── Activation / Renewal ─────────────────────────────────────────────────
    // ACTIVATED      = blockchain confirmed, unlock early (like paddle subscription.activated)
    // PAYMENT_COMPLETED = "finished", fully settled (like paddle transaction.completed → renewal)
    case 'ACTIVATED':
    case 'PAYMENT_COMPLETED': {
      const isRenewal = eventType === 'PAYMENT_COMPLETED';

      const cryptoSubDoc: CryptoSubDoc = {
        provider:          'nowpayments',
        subscriptionId,
        status:            'ACTIVE',
        cancelAtPeriodEnd: false,
        startTime:         payload.startTime ?? new Date().toISOString(),
        lastUpdated:       new Date(),
      };

      await db.collection('users').updateOne(userQuery(userId), {
        $set: {
          apiPlan,
          apiCryptoSubscription: cryptoSubDoc,
          banStatus: 'none',
          banReason: '',
          banAt:     null,
        },
        // On renewal: clear any scheduled downgrade set by a previous downgrade request.
        // This matches what paddle-handler does on PAYMENT_COMPLETED.
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

    // ── Payment failure / Expired ────────────────────────────────────────────
    // Mirrors paddle-handler API SUSPENDED/PAYMENT_FAILED:
    // only suspend the crypto sub — don't revert apiPlan to 'free' (Paddle doesn't either).
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

    // ── Explicit cancellation ────────────────────────────────────────────────
    // Reached when a user explicitly cancels (e.g. via support).
    // For plan-change downgrades the change-plan handler writes to DB directly
    // and never routes through here.
    case 'CANCELLED': {
      // periodEnd is injected by changeNowPaymentsPlanHandler when it fires a
      // manual CANCELLED payload; for external cancellations fall back to now.
      const periodEnd = payload.rawEvent?.periodEnd ?? new Date().toISOString();

      await db.collection('users').updateOne(userQuery(userId), {
        $set: {
          // Keep plan ACTIVE until periodEnd — resolveEffectivePlan() in the
          // status worker will downgrade automatically once the date passes.
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

      // Fire-and-forget cancellation email (same as paddle-handler)
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

    // ── Refund ───────────────────────────────────────────────────────────────
    // Paddle API refund only logs — no plan state change. We match that.
    case 'REFUNDED': {
      await logPaymentEvent(userId, subscriptionId, 'refund', payload);
      console.log(`[NowPayments] API refund logged for ${userId}.`);
      break;
    }
  }

  // Always sync features after any API plan event
  await syncUserFeatures(db, redis, userId);
}

// ═════════════════════════════════════════════════════════════════════════════
//  APP PRO PLAN  (productType === 'app')
// ═════════════════════════════════════════════════════════════════════════════

async function handleAppPlanEvent(
  eventType: NowPaymentsEventPayload['eventType'],
  userId:    string,
  payload:   NowPaymentsEventPayload,
) {
  const subscriptionId = payload.subscriptionId!;

  switch (eventType) {

    // ── Activation / Renewal ─────────────────────────────────────────────────
    case 'ACTIVATED':
    case 'PAYMENT_COMPLETED': {
      const isRenewal = eventType === 'PAYMENT_COMPLETED';

      const cryptoSubDoc: CryptoSubDoc = {
        provider:          'nowpayments',
        subscriptionId,
        status:            'ACTIVE',
        cancelAtPeriodEnd: false,
        startTime:         payload.startTime ?? new Date().toISOString(),
        lastUpdated:       new Date(),
      };

      // Need the full user doc for fingerprint bonus-credit check
      const user            = await db.collection('users').findOne(userQuery(userId));
      const actualWyiUserId = user?.wyiUserId ?? userId;

      await db.collection('users').updateOne(userQuery(userId), {
        $set: {
          plan:               'pro',
          cryptoSubscription: cryptoSubDoc,
          banStatus:          'none',
          banReason:          '',
          banAt:              null,
        },
        // Clear any scheduled downgrade from a previous cancellation or downgrade.
        // On renewal this is a fresh billing period — same as paddle-handler PAYMENT_COMPLETED.
        $unset: {
          scheduledDowngradeAt:    '',
          'cryptoSubscription.canceledAt':  '',
          'cryptoSubscription.periodEnd':   '',
        },
      });

      // ── Pro bonus credits (fingerprint-gated, first activation only) ────────
      // Matches paddle-handler ACTIVATED logic exactly.
      // isRenewal guard prevents re-awarding on every monthly renewal.
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
          // Mark as having been considered (prevents re-check on next activation)
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

      // Migrate existing emails to Pro storage quota (first activation only)
      if (!isRenewal) {
        migrateUserEmailsToPro(userId).catch(err =>
          console.error(`[NowPayments] Email migration failed for ${userId}:`, err),
        );
      }
      break;
    }

    // ── Payment failure ───────────────────────────────────────────────────────
    // Matches paddle-handler PAYMENT_FAILED for app:
    // suspend sub, revoke apiPlan + proBonusCredits, sync features.
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

    // ── Explicit cancellation ─────────────────────────────────────────────────
    // Matches paddle-handler CANCELLED for app exactly.
    // The plan stays ACTIVE until periodEnd; the scheduled-downgrade worker
    // flips it to free once the date passes.
    case 'CANCELLED': {
      const periodEnd = payload.rawEvent?.periodEnd ?? new Date().toISOString();

      await db.collection('users').updateOne(userQuery(userId), {
        $set: {
          'cryptoSubscription.status':            'ACTIVE',
          'cryptoSubscription.cancelAtPeriodEnd': true,
          'cryptoSubscription.canceledAt':        new Date().toISOString(),
          'cryptoSubscription.periodEnd':         periodEnd,
          'cryptoSubscription.lastUpdated':       new Date(),
          scheduledDowngradeAt:                   new Date(periodEnd),
          // Revoke API plan and bonus credits immediately on app cancel,
          // same as paddle-handler CANCELLED for app.
          apiPlan:         'free',
          proBonusCredits: 0,
        },
        $unset: { receivedProBonusCredits: '' },
      });

      await syncUserFeatures(db, redis, userId);
      await logPaymentEvent(userId, subscriptionId, 'subscription_cancelled', payload);
      console.log(`[NowPayments] User ${userId} cancelled. Pro access until ${periodEnd}.`);

      // Fire-and-forget cancellation email with storage/email-count summary
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

    // ── Refund ────────────────────────────────────────────────────────────────
    // Matches paddle-handler REFUNDED for app: set plan=free, revoke everything.
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
//  Stores subscriptionId → userId link BEFORE payment so webhook can resolve user.
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
    userId: rawUserId,
    productType = 'app',
  } = payload;

  if (!eventType) {
    return res.status(400).json({ success: false, message: 'Missing eventType' });
  }

  // Resolve userId: provided in payload first, then fall back to DB lookup.
  // The DB lookup handles IPN retries where the payload metadata might be missing.
  let userId = rawUserId;
  if (!userId && subscriptionId) {
    const u = await findUserByNpSubscriptionId(subscriptionId);
    if (u) userId = u.wyiUserId;
  }

  if (!userId) {
    console.warn(`[NowPayments] Could not resolve userId for subscriptionId=${subscriptionId}`);
    // Return 200 so NP stops retrying — log as orphan for manual review.
    return res.status(200).json({ success: true, warning: 'User not found, logged as orphan.' });
  }

  try {
    if (productType === 'credits') {
      // Credits are granted on ACTIVATED (early) or PAYMENT_COMPLETED (final confirm).
      // The Redis idempotency key prevents double-granting.
      if (eventType === 'ACTIVATED' || eventType === 'PAYMENT_COMPLETED') {
        await handleCreditPurchase(userId, payload);
      }
      return res.status(200).json({ success: true });
    }

    if (productType === 'api') {
      await handleApiPlanEvent(eventType, userId, payload);
      return res.status(200).json({ success: true });
    }

    // Default: app Pro plan
    await handleAppPlanEvent(eventType, userId, payload);
    return res.status(200).json({ success: true });

  } catch (error) {
    console.error(`[NowPayments] Error handling ${eventType} for ${userId}:`, error);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  PLAN CHANGE HANDLER   POST /nowpayments/change-plan
//
//  NOWPayments has NO "change subscription" PATCH API (unlike Paddle).
//
//  UPGRADE  (e.g. startup → growth):
//    1. DELETE old NP subscription (stops future renewal invoices at old price)
//    2. Write new plan to DB optimistically so features unlock immediately
//    3. Return requiresNewCheckout: true → frontend opens new checkout
//    4. IPN "ACTIVATED" on new payment confirms and writes new subscriptionId
//
//  DOWNGRADE  (e.g. growth → startup):
//    1. DELETE old NP subscription (stops future renewal invoices)
//    2. Write cancelAtPeriodEnd + scheduledDowngradeAt to DB
//    3. User keeps full access until periodEnd
//    4. requiresNewCheckout: false — user re-subscribes to cheaper plan later
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

  // ── Validation ─────────────────────────────────────────────────────────────
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

  // ── Load user ───────────────────────────────────────────────────────────────
  const user = await db.collection('users').findOne({
    $or: [{ wyiUserId: rawUserId }, { linkedProviderIds: rawUserId }],
  });
  if (!user) {
    return res.status(404).json({ success: false, message: 'User not found.' });
  }

  // Resolve which sub field and current plan to use
  const subField    = productType === 'api' ? 'apiCryptoSubscription' : 'cryptoSubscription';
  const currentPlan = productType === 'api'
    ? (user.apiPlan as string ?? 'free')
    : (user.plan === 'pro' ? 'pro' : 'free');

  const sub = user[subField] as (CryptoSubDoc & Record<string, any>) | undefined;

  // ── Guards ──────────────────────────────────────────────────────────────────
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

  // ── Cancel existing NP subscription ────────────────────────────────────────
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

  // ── UPGRADE ─────────────────────────────────────────────────────────────────
  if (changeType === 'upgrade') {
    // Write new plan optimistically — features unlock before the new payment
    // is confirmed (same as Paddle upgrade in api-plan-change-handler.ts).
    // IPN ACTIVATED will overwrite subscriptionId once user pays.
    await db.collection('users').updateOne(q, {
      $set: {
        // For API: write the target plan name. For app: always 'pro'.
        ...(productType === 'api'
          ? { apiPlan: targetPlan }
          : { plan:   'pro'      }
        ),
        [`${subField}.status`]:            'PENDING_RENEWAL',
        [`${subField}.cancelAtPeriodEnd`]: false,
        [`${subField}.lastUpdated`]:       new Date(),
      },
      $unset: {
        // Clear any prior downgrade scheduling
        apiScheduledDowngradeAt:           '',
        apiScheduledDowngradePlan:         '',
        scheduledDowngradeAt:              '',
        [`${subField}.canceledAt`]:        '',
        [`${subField}.periodEnd`]:         '',
      },
    });

    await syncUserFeatures(db, redis, rawUserId);

    // Log reason for analytics (fire-and-forget)
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

  // ── DOWNGRADE ───────────────────────────────────────────────────────────────
  // Keep access until the period end that was stored when the sub last renewed.
  // Fallback chain: periodEnd → nextBilledAt → canceledAt → now + 30 days.
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

  // Log reason (fire-and-forget)
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