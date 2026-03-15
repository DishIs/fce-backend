// api/src/handlers/deletion-handler.ts
// ─────────────────────────────────────────────────────────────────────────────
//  Account deletion: 7-day cooldown, immediate purge of sensitive data,
//  then permanent delete by worker. Internal API only.
// ─────────────────────────────────────────────────────────────────────────────
import { Request, Response } from 'express';
import { ObjectId } from 'mongodb';
import { db, gfs, IUser, IDeletionCooldown } from '../config/mongo';
import { client as redis } from '../config/redis';
import { getUser } from '../services/user';
import { sendEmail } from '../email/resend';
import { getDeletionScheduledEmailHtml, getDeletionPermanentEmailHtml } from '../email/templates';

const COOLDOWN_DAYS = 7;
const IP_COOLDOWN_HOURS = 24;
const EMAIL_COOLDOWN_DAYS_MIN = 7;
const EMAIL_COOLDOWN_DAYS_MAX = 14;
const APP_URL = process.env.APP_URL || 'https://www.freecustom.email';

// ── Immediate purge: stored emails, attachments, Redis mailbox + cache, clear inbox lists ──
export async function purgeUserSensitiveData(userId: ObjectId, inboxes: string[]): Promise<{ emailsDeleted: number; filesDeleted: number }> {
  const normalizedInboxes = inboxes.map((i) => String(i).toLowerCase()).filter(Boolean);
  let emailsDeleted = 0;
  let filesDeleted = 0;

  const docs = await db.collection('saved_emails').find({ userId }, { projection: { _id: 1, 'attachments.gridfs_id': 1, 'attachments.gridfsId': 1 } }).toArray();
  const gridfsIds = docs.flatMap((d: any) =>
    (d.attachments || []).map((a: any) => a.gridfs_id || a.gridfsId).filter(Boolean)
  );

  if (gridfsIds.length > 0 && gfs) {
    await Promise.allSettled(
      gridfsIds.map(async (id: any) => {
        try {
          const oid = typeof id === 'string' ? new ObjectId(id) : id;
          await gfs.delete(oid);
          filesDeleted++;
        } catch (_) {}
      })
    );
  }

  const result = await db.collection('saved_emails').deleteMany({ userId });
  emailsDeleted = result.deletedCount;

  const plans = ['pro', 'free', 'anonymous'];
  for (const inbox of normalizedInboxes) {
    for (const plan of plans) {
      try {
        await redis.del(`maildrop:${plan}:${inbox}:index`);
        await redis.del(`maildrop:${plan}:${inbox}:data`);
      } catch (_) {}
    }
    try {
      await redis.del(`user_data_cache:${inbox}`);
    } catch (_) {}
  }

  return { emailsDeleted, filesDeleted };
}

// ── Add to cooldown (email or IP blocked from re-registering) ─────────────────
async function addDeletionCooldown(type: 'email' | 'ip', value: string, hoursFromNow: number): Promise<void> {
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return;
  const blockedUntil = new Date(Date.now() + hoursFromNow * 60 * 60 * 1000);
  await db.collection<IDeletionCooldown>('deletion_cooldowns').updateOne(
    { type, value: normalized },
    { $set: { type, value: normalized, blockedUntil, createdAt: new Date() } },
    { upsert: true }
  );
}

// ── Request account deletion (soft delete, 7-day cooldown) ────────────────────
export async function requestDeleteAccountHandler(req: Request, res: Response): Promise<any> {
  const { wyiUserId, ip } = req.body;

  if (!wyiUserId) {
    return res.status(400).json({ success: false, message: 'wyiUserId is required.' });
  }

  try {
    const user = await getUser(wyiUserId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    if ((user as any).deletionStatus === 'scheduled') {
      return res.status(400).json({
        success: false,
        message: 'Deletion already scheduled.',
        scheduledDeletionAt: (user as any).scheduledDeletionAt,
      });
    }
    if ((user as any).deletionStatus === 'permanent') {
      return res.status(400).json({ success: false, message: 'Account already permanently deleted.' });
    }

    const userId = user._id as ObjectId;
    const allInboxes = [...(user.inboxes || []), ...(user.apiInboxes || [])].map((i) => String(i).toLowerCase());
    const uniqueInboxes = [...new Set(allInboxes)];

    // 1) Immediately purge sensitive data
    const { emailsDeleted, filesDeleted } = await purgeUserSensitiveData(userId, uniqueInboxes);

    // 2) Revoke all API keys
    await db.collection('api_keys').updateMany(
      { wyiUserId: user.wyiUserId },
      { $set: { active: false, revokedAt: new Date() } }
    );

    // 3) Cancel subscriptions (DB only; Paddle webhook may sync separately)
    if (user.subscription?.subscriptionId) {
      await db.collection('users').updateOne(
        { _id: userId },
        {
          $set: {
            'subscription.status': 'CANCELLED',
            'subscription.cancelAtPeriodEnd': true,
            'subscription.canceledAt': new Date().toISOString(),
            'subscription.lastUpdated': new Date(),
          },
        }
      );
    }
    if ((user as any).apiSubscription?.subscriptionId) {
      await db.collection('users').updateOne(
        { _id: userId },
        {
          $set: {
            'apiSubscription.status': 'CANCELLED',
            'apiSubscription.cancelAtPeriodEnd': true,
            'apiSubscription.canceledAt': new Date().toISOString(),
            'apiSubscription.lastUpdated': new Date(),
          },
        }
      );
    }

    const deletionRequestedAt = new Date();
    const scheduledDeletionAt = new Date(deletionRequestedAt.getTime() + COOLDOWN_DAYS * 24 * 60 * 60 * 1000);

    // 4) Clear inbox addresses and set deletion state (keep email for restore message)
    await db.collection('users').updateOne(
      { _id: userId },
      {
        $set: {
          deletionStatus: 'scheduled',
          deletionRequestedAt,
          scheduledDeletionAt,
          ipAtDeletionRequest: (ip || '').trim() || undefined,
          inboxes: [],
          apiInboxes: [],
          inboxHistory: [],
          customDomains: [],
          mutedSenders: [],
          settings: {},
          fcmToken: null,
        },
      }
    );

    // 5) IP cooldown 24h (so same IP cannot create new account for 24h)
    if (ip && String(ip).trim()) {
      await addDeletionCooldown('ip', String(ip).trim(), IP_COOLDOWN_HOURS);
    }

    // 6) Email user
    const html = getDeletionScheduledEmailHtml(scheduledDeletionAt, APP_URL);
    await sendEmail({
      to: user.email,
      subject: 'Your FreeCustom.Email account is scheduled for deletion',
      html,
      from: 'noreply',
    }).catch((err) => console.error('[deletion] Scheduled email failed:', err));

    return res.status(200).json({
      success: true,
      message: 'Account scheduled for deletion. Sensitive data has been removed. You can restore until the cooldown ends.',
      scheduledDeletionAt: scheduledDeletionAt.toISOString(),
      canRestoreUntil: scheduledDeletionAt.toISOString(),
      emailsDeleted,
      filesDeleted,
    });
  } catch (err) {
    console.error('[requestDeleteAccount]', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
}

// ── List users by deletion status (internal, for dashboard) ────────────────────
export async function getDeletionListHandler(req: Request, res: Response): Promise<any> {
  try {
    const scheduled = await db
      .collection('users')
      .find({ deletionStatus: 'scheduled' }, { projection: { wyiUserId: 1, email: 1, scheduledDeletionAt: 1, deletionRequestedAt: 1 } })
      .toArray();
    const permanent = await db
      .collection('users')
      .find({ deletionStatus: 'permanent' }, { projection: { wyiUserId: 1 } })
      .toArray();

    return res.status(200).json({
      success: true,
      scheduled: scheduled.map((u: any) => ({
        wyiUserId: u.wyiUserId,
        email: u.email,
        scheduledDeletionAt: u.scheduledDeletionAt?.toISOString?.() ?? null,
        deletionRequestedAt: u.deletionRequestedAt?.toISOString?.() ?? null,
      })),
      permanent: permanent.map((u: any) => ({ wyiUserId: u.wyiUserId })),
    });
  } catch (err) {
    console.error('[getDeletionList]', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
}

// ── Restore account (during cooldown only) ────────────────────────────────────
export async function restoreAccountHandler(req: Request, res: Response): Promise<any> {
  const { wyiUserId } = req.body;

  if (!wyiUserId) {
    return res.status(400).json({ success: false, message: 'wyiUserId is required.' });
  }

  try {
    const user = await getUser(wyiUserId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    const status = (user as any).deletionStatus;
    const scheduledAt = (user as any).scheduledDeletionAt as Date | undefined;

    if (status !== 'scheduled') {
      return res.status(400).json({
        success: false,
        message: status === 'permanent' ? 'Account was permanently deleted and cannot be restored.' : 'No deletion is scheduled.',
      });
    }

    if (scheduledAt && new Date() > new Date(scheduledAt)) {
      return res.status(400).json({ success: false, message: 'Cooldown period has ended. Account cannot be restored.' });
    }

    await db.collection('users').updateOne(
      { _id: user._id },
      {
        $unset: {
          deletionStatus: '',
          deletionRequestedAt: '',
          scheduledDeletionAt: '',
          ipAtDeletionRequest: '',
        },
      }
    );

    return res.status(200).json({
      success: true,
      message: 'Account restored. You can log in again. API keys and subscriptions were not restored.',
    });
  } catch (err) {
    console.error('[restoreAccount]', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
}
