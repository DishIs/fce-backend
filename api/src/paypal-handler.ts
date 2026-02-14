// api/src/paypal-handler.ts
import { Request, Response } from 'express';
import { db } from './mongo';
import { ISubscription, IPaymentLog } from './mongo';

// ---------------------------------------------------------------
// Type map for incoming webhook events forwarded from Next.js
// ---------------------------------------------------------------
type PayPalEventType =
  | 'ACTIVATED'
  | 'CANCELLED'
  | 'SUSPENDED'
  | 'EXPIRED'
  | 'UPDATED'
  | 'PAYMENT_COMPLETED'
  | 'PAYMENT_FAILED'
  | 'REFUNDED';

interface SubscriptionEventPayload {
  eventType: PayPalEventType;
  userId?: string;          // wyiUserId — may be null for payment events
  subscriptionId?: string;
  planId?: string;
  status?: string;
  startTime?: string;
  payerEmail?: string;
  payerName?: string;
  amount?: string;
  currency?: string;
  rawEvent: any;
}

// ---------------------------------------------------------------
// Helper: Find user by subscriptionId when userId isn't available
// (Used for payment events where custom_id may be absent)
// ---------------------------------------------------------------
async function findUserBySubscriptionId(subscriptionId: string) {
  return await db.collection('users').findOne({
    'subscription.subscriptionId': subscriptionId,
  });
}

// ---------------------------------------------------------------
// Helper: Log every event to payment_logs for audit trail
// ---------------------------------------------------------------
async function logPaymentEvent(
  userId: string,
  subscriptionId: string,
  transactionType: IPaymentLog['transactionType'],
  payload: SubscriptionEventPayload
) {
  const log: IPaymentLog = {
    userId,
    transactionType,
    provider: 'paypal',
    subscriptionId,
    amount: payload.amount,
    currency: payload.currency,
    details: payload.rawEvent,
    createdAt: new Date(),
  };
  await db.collection('payment_logs').insertOne(log);
}

// ---------------------------------------------------------------
// Main Webhook Event Handler
// Called by: POST /paypal/subscription-event  (internal route)
// ---------------------------------------------------------------
export async function handlePayPalSubscriptionEvent(req: Request, res: Response) {
  const payload = req.body as SubscriptionEventPayload;
  const { eventType, subscriptionId, userId: rawUserId } = payload;

  if (!eventType || !subscriptionId) {
    return res.status(400).json({ success: false, message: 'Missing eventType or subscriptionId' });
  }

  // Resolve userId — either directly provided or found via subscriptionId
  let userId = rawUserId;
  if (!userId) {
    const user = await findUserBySubscriptionId(subscriptionId);
    if (user) {
      userId = user.wyiUserId;
    }
  }

  if (!userId) {
    console.warn(`[PayPal Handler] Could not resolve userId for subscription ${subscriptionId}`);
    // Return 200 so Next.js webhook doesn't error, but log it.
    return res.status(200).json({ success: true, warning: 'User not found, event logged as orphan.' });
  }

  try {
    switch (eventType) {
      // ——————————————————————————————————————————
      case 'ACTIVATED': {
        const subscriptionData: ISubscription = {
          provider: 'paypal',
          subscriptionId,
          planId: payload.planId,
          status: 'ACTIVE',
          startTime: payload.startTime ?? new Date().toISOString(),
          payerEmail: payload.payerEmail,
          payerName: payload.payerName,
          lastUpdated: new Date(),
        };

        await db.collection('users').updateOne(
          {
            $or: [
              { wyiUserId: userId },
              { linkedProviderIds: userId },
            ]
          },
          { $set: { plan: 'pro', subscription: subscriptionData } }
        );
        await logPaymentEvent(userId, subscriptionId, 'subscription_created', payload);
        console.log(`[PayPal Handler] User ${userId} upgraded to PRO.`);
        break;
      }

      // ——————————————————————————————————————————
      case 'CANCELLED':
      case 'EXPIRED': {
        await db.collection('users').updateOne(
          {
            $or: [
              { wyiUserId: userId },
              { linkedProviderIds: userId },
            ]
          },
          {
            $set: {
              plan: 'free',
              'subscription.status': eventType === 'CANCELLED' ? 'CANCELLED' : 'EXPIRED',
              'subscription.lastUpdated': new Date(),
            },
          }
        );
        await logPaymentEvent(userId, subscriptionId, 'subscription_cancelled', payload);
        console.log(`[PayPal Handler] User ${userId} downgraded to FREE (${eventType}).`);
        break;
      }

      // ——————————————————————————————————————————
      case 'SUSPENDED': {
        // Payment failed — grace period before full cancellation.
        // Keep plan as 'pro' but flag the subscription as suspended.
        await db.collection('users').updateOne(
          {
            $or: [
              { wyiUserId: userId },
              { linkedProviderIds: userId },
            ]
          },
          {
            $set: {
              'subscription.status': 'SUSPENDED',
              'subscription.lastUpdated': new Date(),
            },
          }
        );
        await logPaymentEvent(userId, subscriptionId, 'subscription_renewed', payload); // Log as a renewal issue
        console.warn(`[PayPal Handler] User ${userId} subscription SUSPENDED (payment issue).`);
        break;
      }

      // ——————————————————————————————————————————
      case 'UPDATED': {
        await db.collection('users').updateOne(
          {
            $or: [
              { wyiUserId: userId },
              { linkedProviderIds: userId },
            ]
          },
          {
            $set: {
              'subscription.planId': payload.planId,
              'subscription.status': (payload.status ?? 'ACTIVE') as ISubscription['status'],
              'subscription.lastUpdated': new Date(),
            },
          }
        );
        console.log(`[PayPal Handler] User ${userId} subscription UPDATED.`);
        break;
      }

      // ——————————————————————————————————————————
      case 'PAYMENT_COMPLETED': {
        // Successful renewal — ensure plan is still PRO and subscription is ACTIVE
        await db.collection('users').updateOne(
          {
            $or: [
              { wyiUserId: userId },
              { linkedProviderIds: userId },
            ]
          },
          {
            $set: {
              plan: 'pro',
              'subscription.status': 'ACTIVE',
              'subscription.lastUpdated': new Date(),
            },
          }
        );
        await logPaymentEvent(userId, subscriptionId, 'subscription_renewed', payload);
        console.log(`[PayPal Handler] User ${userId} payment received — plan renewed.`);
        break;
      }

      // ——————————————————————————————————————————
      case 'PAYMENT_FAILED': {
        // Do NOT immediately downgrade. Suspend and let CANCELLED/EXPIRED handle the final downgrade.
        await db.collection('users').updateOne(
          {
            $or: [
              { wyiUserId: userId },
              { linkedProviderIds: userId },
            ]
          },
          {
            $set: {
              'subscription.status': 'SUSPENDED',
              'subscription.lastUpdated': new Date(),
            },
          }
        );
        console.warn(`[PayPal Handler] User ${userId} payment FAILED.`);
        break;
      }

      // ——————————————————————————————————————————
      case 'REFUNDED': {
        await logPaymentEvent(userId, subscriptionId, 'refund', payload);
        console.log(`[PayPal Handler] Refund logged for user ${userId}.`);
        break;
      }

      default:
        console.log(`[PayPal Handler] Unhandled event type: ${eventType}`);
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error(`[PayPal Handler] Error handling ${eventType} for user ${userId}:`, error);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
}