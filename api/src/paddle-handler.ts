// api/src/paddle-handler.ts
import { Request, Response } from 'express';
import { db } from './mongo';
import { ISubscription, IPaymentLog } from './mongo';
import { migrateUserEmailsToPro } from './upgrade-migration';
import { getCancellationEmailHtml } from './email/templates';
import nodemailer from 'nodemailer';


// ---------------------------------------------------------------
// Paddle event types forwarded from Next.js webhook route
// ---------------------------------------------------------------
type PaddleEventType =
  | 'TRIALING'
  | 'ACTIVATED'
  | 'CANCELLED'
  | 'SUSPENDED'
  | 'UPDATED'
  | 'PAYMENT_COMPLETED'
  | 'PAYMENT_FAILED'
  | 'REFUNDED';

interface PaddleSubscriptionEventPayload {
  eventType: PaddleEventType;
  userId?: string;
  subscriptionId?: string;
  customerId?: string;   // <-- NEW
  priceId?: string;
  status?: string;
  startTime?: string;
  nextBilledAt?: string;
  payerEmail?: string;
  canceledAt?: string;
  pausedAt?: string;
  scheduledChange?: any;
  amount?: string | number;
  currency?: string;
  rawEvent: any;
}

// ---------------------------------------------------------------
// Helper: Resolve userId via subscriptionId when not in payload
// ---------------------------------------------------------------
async function findUserBySubscriptionId(subscriptionId: string) {
  return await db.collection('users').findOne({
    'subscription.subscriptionId': subscriptionId,
  });
}

// Helper (add once, near the top of the file):
async function sendCancellationEmail(
  toEmail: string,
  data: {
    periodEnd: string;
    emailCount: number;
    storageUsedMB: number;
    inboxCount: number;
  }
) {
  if (!process.env.SMTP_USER) return; // skip if mailer not configured

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.zoho.in',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_PORT === '465',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  await transporter.sendMail({
    from: process.env.MAIL_FROM || '"FreeCustom.Email" <no-reply@freecustom.email>',
    to: toEmail,
    subject: 'Your FreeCustom.Email Pro subscription has been cancelled',
    html: getCancellationEmailHtml(data),
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
    amount: payload.amount !== undefined ? String(payload.amount) : undefined,
    currency: payload.currency,
    details: payload.rawEvent,
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

      // Paddle's subscription.canceled webhook includes:
      //   data.scheduled_change.effective_at  — when cancel takes effect (period end)
      //   data.current_billing_period.ends_at — current period end
      //
      // We always schedule the downgrade at the period end, never a fixed offset.

      // ── ACTIVATED ──────────────────────────────────────────────────────────────
      case 'ACTIVATED': {
        const subscriptionData: ISubscription = {
          provider: 'paddle',
          subscriptionId,
          planId: payload.priceId,
          status: payload.status === 'trialing' ? 'TRIALING' : 'ACTIVE',
          cancelAtPeriodEnd: false,
          startTime: payload.startTime ?? new Date().toISOString(),
          payerEmail: payload.payerEmail,
          lastUpdated: new Date(),
          ...(payload.customerId && { customerId: payload.customerId }),
          ...(payload.nextBilledAt && { nextBilledAt: payload.nextBilledAt }),
          ...(payload.scheduledChange && { scheduledChange: payload.scheduledChange }),
        };

        await db.collection('users').updateOne(
          userQuery(userId),
          {
            $set: { plan: 'pro', subscription: subscriptionData },
            // Clear any pending downgrade — handles resubscribes before grace expires
            $unset: { scheduledDowngradeAt: '' },
          }
        );
        await logPaymentEvent(userId, subscriptionId, 'subscription_created', payload);
        console.log(`[Paddle Handler] User ${userId} upgraded to PRO.`);

        migrateUserEmailsToPro(userId).catch(err =>
          console.error(`[Paddle Handler] Email migration failed for ${userId}:`, err)
        );
        break;
      }

      // ── CANCELLED case — replace with this ───────────────────────────────────────
      case 'CANCELLED': {
        const data = payload.rawEvent?.data;

        const periodEnd: string =
          data?.scheduled_change?.effective_at ??
          data?.current_billing_period?.ends_at ??
          payload.canceledAt ??
          new Date().toISOString();

        const scheduledDowngradeAt = new Date(periodEnd);
        const cancelledAt = payload.canceledAt ?? new Date().toISOString();

        await db.collection('users').updateOne(
          userQuery(userId),
          {
            $set: {
              'subscription.status': 'ACTIVE',
              'subscription.cancelAtPeriodEnd': true,
              'subscription.canceledAt': cancelledAt,
              'subscription.periodEnd': periodEnd,
              'subscription.lastUpdated': new Date(),
              scheduledDowngradeAt,
            },
          }
        );

        await logPaymentEvent(userId, subscriptionId, 'subscription_cancelled', payload);
        console.log(`[Paddle Handler] User ${userId} cancelled. Pro access until ${periodEnd}.`);

        // Send cancellation email with live usage stats
        try {
          const user = await db.collection('users').findOne(userQuery(userId));
          if (user?.email) {
            // Count emails and storage from saved_emails
            const [emailCountResult, storageResult] = await Promise.all([
              db.collection('saved_emails').countDocuments({ userId: user._id }),
              db.collection('saved_emails').aggregate([
                { $match: { userId: user._id } },
                { $unwind: { path: '$attachments', preserveNullAndEmptyArrays: true } },
                { $group: { _id: null, totalBytes: { $sum: { $ifNull: ['$attachments.size', 0] } } } },
              ]).toArray(),
            ]);

            const emailCount = emailCountResult;
            const storageUsedMB = ((storageResult[0]?.totalBytes ?? 0) / (1024 * 1024));
            const inboxCount = Array.isArray(user.inboxes) ? user.inboxes.length : 0;

            sendCancellationEmail(user.email, {
              periodEnd,
              emailCount,
              storageUsedMB,
              inboxCount,
            }).catch(err => console.error('[Paddle Handler] Failed to send cancellation email:', err));
          }
        } catch (err) {
          console.error('[Paddle Handler] Error fetching stats for cancellation email:', err);
        }

        break;
      }

      // ── PAYMENT_COMPLETED ──────────────────────────────────────────────────────
      case 'PAYMENT_COMPLETED': {
        // Fired on every successful charge — renewal OR conversion from trial.
        // Clear any cancellation state in case user resubscribed within grace period.
        await db.collection('users').updateOne(
          userQuery(userId),
          {
            $set: {
              plan: 'pro',
              'subscription.status': 'ACTIVE',
              'subscription.cancelAtPeriodEnd': false,
              'subscription.lastUpdated': new Date(),
            },
            $unset: {
              scheduledDowngradeAt: '',
              'subscription.canceledAt': '',
              'subscription.periodEnd': '',
            },
          }
        );
        await logPaymentEvent(userId, subscriptionId, 'subscription_renewed', payload);
        console.log(`[Paddle Handler] User ${userId} payment received — plan renewed.`);
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
              'subscription.status': 'SUSPENDED',
              'subscription.pausedAt': payload.pausedAt ?? new Date().toISOString(),
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
              'subscription.planId': payload.priceId,
              'subscription.status': (payload.status ?? 'ACTIVE') as ISubscription['status'],
              'subscription.lastUpdated': new Date(),
            },
          }
        );
        console.log(`[Paddle Handler] User ${userId} subscription UPDATED.`);
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
              'subscription.status': 'SUSPENDED',
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