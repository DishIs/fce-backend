// api/src/paddle-handler.ts
import { Request, Response } from 'express';
import { db } from './mongo';
import { ISubscription, IPaymentLog } from './mongo';

// ---------------------------------------------------------------
// Paddle event types forwarded from Next.js webhook route
// ---------------------------------------------------------------
type PaddleEventType =
  | 'ACTIVATED'
  | 'CANCELLED'
  | 'SUSPENDED'
  | 'UPDATED'
  | 'PAYMENT_COMPLETED'
  | 'PAYMENT_FAILED'
  | 'REFUNDED';

interface PaddleSubscriptionEventPayload {
  eventType:       PaddleEventType;
  userId?:         string;
  subscriptionId?: string;
  priceId?:        string;
  status?:         string;
  startTime?:      string;
  nextBilledAt?:   string;
  payerEmail?:     string;
  canceledAt?:     string;
  pausedAt?:       string;
  scheduledChange?: any;
  amount?:         string | number;
  currency?:       string;
  rawEvent:        any;
}

// ---------------------------------------------------------------
// Helper: Resolve userId via subscriptionId when not in payload
// ---------------------------------------------------------------
async function findUserBySubscriptionId(subscriptionId: string) {
  return await db.collection('users').findOne({
    'subscription.subscriptionId': subscriptionId,
  });
}

// ---------------------------------------------------------------
// Helper: Audit log
// ---------------------------------------------------------------
async function logPaymentEvent(
  userId: string,
  subscriptionId: string,
  transactionType: IPaymentLog['transactionType'],
  payload: PaddleSubscriptionEventPayload
) {
  const log: IPaymentLog = {
    userId,
    transactionType,
    provider: 'paddle',
    subscriptionId,
    amount:   payload.amount !== undefined ? String(payload.amount) : undefined,
    currency: payload.currency,
    details:  payload.rawEvent,
    createdAt: new Date(),
  };
  await db.collection('payment_logs').insertOne(log);
}

// ---------------------------------------------------------------
// Shared user query — supports linked provider IDs
// ---------------------------------------------------------------
function userQuery(userId: string) {
  return {
    $or: [
      { wyiUserId: userId },
      { linkedProviderIds: userId },
    ],
  };
}

// ---------------------------------------------------------------
// Main Handler
// Called by: POST /paddle/subscription-event  (internal route)
// ---------------------------------------------------------------
export async function handlePaddleSubscriptionEvent(req: Request, res: Response) {
  const payload = req.body as PaddleSubscriptionEventPayload;
  const { eventType, subscriptionId, userId: rawUserId } = payload;

  if (!eventType || !subscriptionId) {
    return res.status(400).json({ success: false, message: 'Missing eventType or subscriptionId' });
  }

  // Resolve userId
  let userId = rawUserId;
  if (!userId) {
    const user = await findUserBySubscriptionId(subscriptionId);
    if (user) userId = user.wyiUserId;
  }

  if (!userId) {
    console.warn(`[Paddle Handler] Could not resolve userId for subscription ${subscriptionId}`);
    return res.status(200).json({ success: true, warning: 'User not found, event logged as orphan.' });
  }

  try {
    switch (eventType) {
      // ——————————————————————————————————————————
      case 'ACTIVATED': {
        const subscriptionData: ISubscription = {
          provider:    'paddle',
          subscriptionId,
          planId:      payload.priceId,
          status:      'ACTIVE',
          startTime:   payload.startTime ?? new Date().toISOString(),
          payerEmail:  payload.payerEmail,
          lastUpdated: new Date(),
          // Paddle-specific extras stored on the subscription object
          ...(payload.nextBilledAt    && { nextBilledAt:    payload.nextBilledAt }),
          ...(payload.scheduledChange && { scheduledChange: payload.scheduledChange }),
        };

        await db.collection('users').updateOne(
          userQuery(userId),
          { $set: { plan: 'pro', subscription: subscriptionData } }
        );
        await logPaymentEvent(userId, subscriptionId, 'subscription_created', payload);
        console.log(`[Paddle Handler] User ${userId} upgraded to PRO.`);
        break;
      }

      // ——————————————————————————————————————————
      case 'CANCELLED': {
        await db.collection('users').updateOne(
          userQuery(userId),
          {
            $set: {
              plan: 'free',
              'subscription.status':      'CANCELLED',
              'subscription.canceledAt':  payload.canceledAt ?? new Date().toISOString(),
              'subscription.lastUpdated': new Date(),
            },
          }
        );
        await logPaymentEvent(userId, subscriptionId, 'subscription_cancelled', payload);
        console.log(`[Paddle Handler] User ${userId} downgraded to FREE (CANCELLED).`);
        break;
      }

      // ——————————————————————————————————————————
      case 'SUSPENDED': {
        // Subscription paused — keep plan as pro, flag status only.
        // Paddle will send CANCELLED if it remains paused past the billing period.
        await db.collection('users').updateOne(
          userQuery(userId),
          {
            $set: {
              'subscription.status':      'SUSPENDED',
              'subscription.pausedAt':    payload.pausedAt ?? new Date().toISOString(),
              'subscription.lastUpdated': new Date(),
            },
          }
        );
        console.warn(`[Paddle Handler] User ${userId} subscription SUSPENDED/PAUSED.`);
        break;
      }

      // ——————————————————————————————————————————
      case 'UPDATED': {
        await db.collection('users').updateOne(
          userQuery(userId),
          {
            $set: {
              'subscription.planId':      payload.priceId,
              'subscription.status':      (payload.status ?? 'ACTIVE') as ISubscription['status'],
              'subscription.lastUpdated': new Date(),
            },
          }
        );
        console.log(`[Paddle Handler] User ${userId} subscription UPDATED.`);
        break;
      }

      // ——————————————————————————————————————————
      case 'PAYMENT_COMPLETED': {
        // Successful renewal — ensure plan is PRO and status is ACTIVE
        await db.collection('users').updateOne(
          userQuery(userId),
          {
            $set: {
              plan:                       'pro',
              'subscription.status':      'ACTIVE',
              'subscription.lastUpdated': new Date(),
            },
          }
        );
        await logPaymentEvent(userId, subscriptionId, 'subscription_renewed', payload);
        console.log(`[Paddle Handler] User ${userId} payment received — plan renewed.`);
        break;
      }

      // ——————————————————————————————————————————
      case 'PAYMENT_FAILED': {
        // Suspend without downgrading — Paddle has its own retry logic.
        // It will send CANCELLED after exhausting retries.
        await db.collection('users').updateOne(
          userQuery(userId),
          {
            $set: {
              'subscription.status':      'SUSPENDED',
              'subscription.lastUpdated': new Date(),
            },
          }
        );
        console.warn(`[Paddle Handler] User ${userId} payment FAILED.`);
        break;
      }

      // ——————————————————————————————————————————
      case 'REFUNDED': {
        await logPaymentEvent(userId, subscriptionId, 'refund', payload);
        console.log(`[Paddle Handler] Refund logged for user ${userId}.`);
        break;
      }

      default:
        console.log(`[Paddle Handler] Unhandled eventType: ${eventType}`);
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error(`[Paddle Handler] Error handling ${eventType} for user ${userId}:`, error);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
}