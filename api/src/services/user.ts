import { db } from '../config/mongo';
import { client as redisClient } from '../config/redis';
import { IUser, IUserSettings, ISubscription, IPaymentLog } from '../config/mongo';
import { v4 as uuidv4 } from 'uuid';
import { Request, Response } from 'express';
import { isEmailInDeletionCooldown, isIpInDeletionCooldown } from './deletion-cooldown';

// ── Flatten nested settings ───────────────────────────────────────────────────
function flattenSettings(raw: any): IUserSettings {
  if (raw == null || typeof raw !== 'object') return {} as IUserSettings;
  const result = { ...raw } as Record<string, any>;
  if ('settings' in result && result.settings != null && typeof result.settings === 'object') {
    const inner = flattenSettings(result.settings) as Record<string, any>;
    delete result.settings;
    Object.assign(result, inner);
  }
  return result as IUserSettings;
}

// ── User lookup helper (primary + linked IDs) ─────────────────────────────────
export async function getUser(userId: string): Promise<IUser | null> {
  return await db.collection<IUser>('users').findOne({
    $or: [
      { wyiUserId: userId },
      { linkedProviderIds: userId },
    ],
  });
}

// ── Propagate hadTrial / hadApiTrial from fingerprint siblings ────────────────
//
// When a user logs in, we check whether any other account that shares the
// same device fingerprint already has hadTrial / hadApiTrial = true.
// If so, we copy those flags onto the current account so one person cannot
// keep claiming free trials by creating new auth accounts.
//
// The fingerprint comes from req.userContext (set by attachIdentityContext).
// We also store the fingerprint in the user's 'fingerprints' array for later
// chargeback cross-referencing.
//
async function propagateTrialFlags(
  wyiUserId: string,
  fingerprint: string | undefined,
): Promise<void> {
  if (!fingerprint) return;

  // 1. Store the fingerprint on this user record
  await db.collection('users').updateOne(
    { $or: [{ wyiUserId }, { linkedProviderIds: wyiUserId }] },
    { $addToSet: { fingerprints: fingerprint } },
  );

  // 2. Get all userIds we've ever seen for this fingerprint (Redis set)
  const fpAccounts = await redisClient.sMembers(`abuse:fp_accounts:${fingerprint}`);
  if (fpAccounts.length === 0) return;

  // 3. Look for an account on this fingerprint that already had a trial
  const sibling = await db.collection('users').findOne({
    $and: [
      {
        $or: [
          { wyiUserId: { $in: fpAccounts } },
          { linkedProviderIds: { $elemMatch: { $in: fpAccounts } } },
        ],
      },
      { $or: [{ hadTrial: true }, { hadApiTrial: true }] },
    ],
    wyiUserId: { $ne: wyiUserId }, // don't look up ourselves
  } as any);

  if (!sibling) return;

  const setFields: Record<string, boolean> = {};
  if (sibling.hadTrial)    setFields.hadTrial    = true;
  if (sibling.hadApiTrial) setFields.hadApiTrial = true;

  if (Object.keys(setFields).length > 0) {
    await db.collection('users').updateOne(
      { $or: [{ wyiUserId }, { linkedProviderIds: wyiUserId }] },
      { $set: setFields },
    );
    console.log(
      `[trial-abuse] Propagated trial flags ${JSON.stringify(setFields)} → ${wyiUserId} ` +
      `(sibling: ${sibling.wyiUserId})`,
    );
  }
}


// ─────────────────────────────────────────────────────────────────────────────
//  STATUS & SETTINGS HANDLERS
// ─────────────────────────────────────────────────────────────────────────────

export async function getUserStatusHandler(req: Request, res: Response) {
  const { userId, ip } = req.body;

  if (!userId) {
    return res.status(400).json({ success: false, message: 'User ID required' });
  }

  try {
    const user = await getUser(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const u = user as any;
    const deletionStatus      = u.deletionStatus || 'none';
    const scheduledDeletionAt = u.scheduledDeletionAt ? new Date(u.scheduledDeletionAt) : null;
    const canRestoreUntil     =
      deletionStatus === 'scheduled' && scheduledDeletionAt
        ? scheduledDeletionAt.toISOString()
        : null;

    const banStatus = u.banStatus || 'none';

    return res.status(200).json({
      success:                true,
      plan:                   user.plan,
      subscriptionStatus:     user.subscription?.status,
      hadTrial:               user.hadTrial    || false,
      hadApiTrial:            (u.hadApiTrial)  || false,
      deletion_status:        deletionStatus,
      deletion_scheduled_at:  scheduledDeletionAt ? scheduledDeletionAt.toISOString() : null,
      can_restore_until:      canRestoreUntil,

      // ── Ban info ────────────────────────────────────────────────────────────
      // Frontend uses banStatus to show a "you're banned" screen with a reason
      // and a "contact support" link.
      banStatus,
      ...(banStatus !== 'none' && {
        banReason:    u.banReason    || 'Policy violation.',
        banAt:        u.banAt        ? new Date(u.banAt).toISOString() : null,
        contactEmail: 'support@freecustom.email',
        contactNote:  'To appeal this decision, email us with your account details. Bans are reviewed within 5 business days.',
      }),
    });
  } catch (error) {
    console.error('Error getting user status:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
}

export async function updateSettingsHandler(req: Request, res: Response) {
  const { wyiUserId, ...rest } = req.body;

  if (!wyiUserId) {
    return res.status(400).json({ success: false, message: 'User ID required' });
  }

  try {
    const settingsToUpdate = flattenSettings(rest);

    await db.collection('users').updateOne(
      { $or: [{ wyiUserId }, { linkedProviderIds: wyiUserId }] },
      { $set: { settings: settingsToUpdate } },
    );

    return res.status(200).json({ success: true, message: 'Settings updated' });
  } catch (error) {
    console.error('Error updating settings:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
}

export async function getSettingsHandler(req: Request, res: Response) {
  const { wyiUserId } = req.body;

  if (!wyiUserId) {
    return res.status(400).json({ success: false, message: 'User ID required' });
  }

  try {
    const user = await getUser(wyiUserId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const rawSettings = user.settings ?? {};
    const settings    = flattenSettings(rawSettings);

    const wasNested = JSON.stringify(rawSettings) !== JSON.stringify(settings);
    if (wasNested && user._id) {
      await db.collection('users').updateOne(
        { _id: user._id },
        { $set: { settings } },
      );
    }
    return res.status(200).json({ success: true, settings });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Server error' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  SUBSCRIPTION & BILLING HANDLERS
// ─────────────────────────────────────────────────────────────────────────────

export async function upgradeUserSubscriptionHandler(req: Request, res: Response) {
  const { userId, subscriptionId, planId, status, startTime, payer } = req.body;

  if (!userId || !subscriptionId) {
    return res.status(400).json({ success: false, message: 'Invalid payload' });
  }

  try {
    const subscriptionData: ISubscription = {
      provider:      'paypal',
      subscriptionId,
      planId,
      status:        status || 'ACTIVE',
      startTime,
      payerEmail:    payer?.email,
      payerName:     payer?.name,
      lastUpdated:   new Date(),
    };

    const paymentLog: IPaymentLog = {
      userId,
      transactionType: 'subscription_created',
      provider:        'paypal',
      subscriptionId,
      details:         req.body,
      createdAt:       new Date(),
    };

    await db.collection('payment_logs').insertOne(paymentLog);

    const updateResult = await db.collection('users').updateOne(
      { $or: [{ wyiUserId: userId }, { linkedProviderIds: userId }] },
      { $set: { plan: 'pro', subscription: subscriptionData } },
    );

    if (updateResult.matchedCount === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    return res.status(200).json({ success: true, message: 'User upgraded successfully' });
  } catch (error) {
    console.error('Error upgrading user subscription:', error);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  UPSERT / AUTH
// ─────────────────────────────────────────────────────────────────────────────

export async function upsertUserHandler(req: Request, res: Response) {
  const { wyiUserId, email, name, plan, ip } = req.body;

  if (!wyiUserId || !email || !name) {
    return res.status(400).json({ success: false, message: 'Missing required user data.' });
  }

  try {
    if (ip && (await isIpInDeletionCooldown(ip))) {
      return res.status(403).json({
        success: false,
        message: 'Registration from this network is temporarily blocked. Please try again later.',
      });
    }
    if (await isEmailInDeletionCooldown(email)) {
      return res.status(403).json({
        success: false,
        message: 'This email address cannot register for a short period after account deletion. Please try again later.',
      });
    }

    const usersCollection = db.collection('users');

    // ── Path A: exact wyiUserId match ─────────────────────────────────────────
    const exactMatch = await usersCollection.findOne({ wyiUserId });

    if (exactMatch) {
      const delStatus = (exactMatch as any).deletionStatus;
      if (delStatus === 'scheduled' || delStatus === 'permanent') {
        return res.status(403).json({
          success: false,
          message: delStatus === 'permanent'
            ? 'This account was permanently deleted and cannot log in.'
            : 'This account is scheduled for deletion. Restore it from the dashboard to log in again.',
        });
      }

      // Ban check - block both banned and warned users
      const banStatus = (exactMatch as any).banStatus;
      if (banStatus === 'banned' || banStatus === 'warned') {
        return res.status(403).json({
          success:      false,
          message:      banStatus === 'banned' 
            ? 'Your account has been permanently banned due to a policy violation.'
            : 'Your account has been flagged for review due to high API usage.',
          banStatus:    banStatus,
          banReason:    (exactMatch as any).banReason || 'Policy violation.',
          contactEmail: 'support@freecustom.email',
        });
      }

      const planToSet = exactMatch.plan === 'pro' ? 'pro' : (plan || 'free');
      await usersCollection.updateOne(
        { wyiUserId },
        { $set: { email, name, plan: planToSet, lastLoginAt: new Date() } },
      );

      // Propagate trial flags and store fingerprint on every login
      await propagateTrialFlags(wyiUserId, req.userContext?.fingerprint);

      return res.status(200).json({ success: true, message: 'User synchronized successfully.' });
    }

    // ── Path B: email match → link provider ID ────────────────────────────────
    const emailMatch = await usersCollection.findOne({
      email: email.toLowerCase().trim(),
    });

    if (emailMatch) {
      const delStatus = (emailMatch as any).deletionStatus;
      if (delStatus === 'scheduled' || delStatus === 'permanent') {
        return res.status(403).json({
          success: false,
          message: delStatus === 'permanent'
            ? 'This account was permanently deleted and cannot log in.'
            : 'This account is scheduled for deletion. Restore it from the dashboard to log in again.',
        });
      }

      // Ban check - block both banned and warned users
      const banStatus = (emailMatch as any).banStatus;
      if (banStatus === 'banned' || banStatus === 'warned') {
        return res.status(403).json({
          success:      false,
          message:      banStatus === 'banned' 
            ? 'Your account has been permanently banned due to a policy violation.'
            : 'Your account has been flagged for review due to high API usage.',
          banStatus:    banStatus,
          banReason:    (emailMatch as any).banReason || 'Policy violation.',
          contactEmail: 'support@freecustom.email',
        });
      }

      await usersCollection.updateOne(
        { _id: emailMatch._id },
        {
          $set: {
            lastLoginAt: new Date(),
            ...(emailMatch.name ? {} : { name }),
          },
          $addToSet: { linkedProviderIds: wyiUserId },
        },
      );

      // Propagate trial flags for the CANONICAL userId (emailMatch.wyiUserId)
      await propagateTrialFlags(emailMatch.wyiUserId, req.userContext?.fingerprint);

      return res.status(200).json({
        success:     true,
        message:     'Linked to existing account.',
        canonicalId: emailMatch.wyiUserId,
      });
    }

    // ── Path C: brand new user ────────────────────────────────────────────────
    //
    // Before inserting, check if this fingerprint's sibling accounts had a trial
    // so we can pre-populate hadTrial / hadApiTrial on creation.
    const fingerprint = req.userContext?.fingerprint;
    let inheritedTrialFields: Record<string, boolean> = {};

    if (fingerprint) {
      const fpAccounts = await redisClient.sMembers(`abuse:fp_accounts:${fingerprint}`);
      if (fpAccounts.length > 0) {
        const trialSibling = await usersCollection.findOne({
          $and: [
            {
              $or: [
                { wyiUserId: { $in: fpAccounts } },
                { linkedProviderIds: { $elemMatch: { $in: fpAccounts } } },
              ],
            },
            { $or: [{ hadTrial: true }, { hadApiTrial: true }] },
          ],
        } as any);
        if (trialSibling) {
          if (trialSibling.hadTrial)    inheritedTrialFields.hadTrial    = true;
          if (trialSibling.hadApiTrial) inheritedTrialFields.hadApiTrial = true;
        }
      }
    }

    await usersCollection.updateOne(
      { wyiUserId },
      {
        $set: {
          wyiUserId,
          email:       email.toLowerCase().trim(),
          name,
          plan:        plan || 'free',
          lastLoginAt: new Date(),
          ...inheritedTrialFields,
        },
        $setOnInsert: {
          createdAt:        new Date(),
          inboxes:          [],
          inboxHistory:     [],
          customDomains:    [],
          mutedSenders:     [],
          settings:         {},
          linkedProviderIds: [wyiUserId],
          fingerprints:     fingerprint ? [fingerprint] : [],
          cardFingerprints: [],
        },
      },
      { upsert: true },
    );

    // Now store fingerprint and register userId in the Redis set
    if (fingerprint) {
      await redisClient.sAdd(`abuse:fp_accounts:${fingerprint}`, wyiUserId);
      await redisClient.expire(`abuse:fp_accounts:${fingerprint}`, 30 * 24 * 60 * 60);
    }

    return res.status(200).json({ success: true, message: 'User created successfully.' });
  } catch (error) {
    console.error('Error during user upsert:', error);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  DOMAIN & FEATURE HANDLERS
// ─────────────────────────────────────────────────────────────────────────────

export async function addDomainHandler(req: any, res: any) {
  const { wyiUserId, domain } = req.body;
  const normalizedDomain = domain?.trim().toLowerCase();

  if (!normalizedDomain) return res.status(400).json({ success: false, message: 'Domain is required.' });

  const user = await getUser(wyiUserId);

  if (!user || user.plan !== 'pro') {
    return res.status(403).json({ success: false, message: 'Permission denied.' });
  }

  const existing = await db.collection('users').findOne({
    'customDomains.domain':    normalizedDomain,
    'customDomains.verified':  true,
    _id: { $ne: user._id },
  });

  if (existing) {
    return res.status(409).json({ success: false, message: 'This domain is already verified for another account.' });
  }

  const alreadyExists = await db.collection('users').findOne({
    _id: user._id,
    'customDomains.domain': normalizedDomain,
  });

  if (alreadyExists) {
    return res.status(409).json({ success: false, message: 'You have already added this domain.' });
  }

  const txtRecord = `freecustomemail-verification=${uuidv4()}`;
  const newDomain = {
    domain:    normalizedDomain,
    verified:  false,
    mxRecord:  'mx.freecustom.email',
    txtRecord,
  };

  await db.collection('users').updateOne(
    { _id: user._id },
    { $addToSet: { customDomains: newDomain } },
  );

  await redisClient.del('custom_domains');

  res.status(200).json({ success: true, message: 'Domain added.', data: newDomain });
}

export async function muteSenderHandler(req: any, res: any) {
  const { wyiUserId, senderToMute } = req.body;
  const user = await getUser(wyiUserId);

  if (!user || user.plan !== 'pro') return res.status(403).json({ success: false, message: 'Permission denied.' });

  await db.collection('users').updateOne(
    { _id: user._id },
    { $addToSet: { mutedSenders: senderToMute.toLowerCase() } },
  );

  const userMuteListKey = `mutelist:${user.wyiUserId}`;
  await redisClient.sAdd(userMuteListKey, senderToMute.toLowerCase());

  res.status(200).json({ success: true, message: 'Sender has been muted.' });
}

export async function unmuteSenderHandler(req: Request, res: Response) {
  const { wyiUserId, senderToUnmute } = req.body;
  if (!wyiUserId || !senderToUnmute) return res.status(400).json({ success: false, message: 'Required fields missing.' });

  const user = await getUser(wyiUserId);
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
  if (user.plan !== 'pro') return res.status(403).json({ success: false, message: 'Permission denied.' });

  const sender = senderToUnmute.toLowerCase();

  await db.collection('users').updateOne(
    { _id: user._id },
    { $pull: { mutedSenders: sender } },
  );

  await redisClient.sRem(`mutelist:${user.wyiUserId}`, sender);

  res.status(200).json({ success: true, message: 'Sender has been un-muted.' });
}

export async function getDomainsHandler(req: Request, res: Response) {
  const { wyiUserId } = req.params;
  if (!wyiUserId) return res.status(400).json({ success: false, message: 'User ID is required.' });

  try {
    const user = await getUser(wyiUserId);
    res.status(200).json({ success: true, domains: user?.customDomains || [] });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Internal server error.' });
  }
}

export async function getUserProfileHandler(req: Request, res: Response) {
  const { wyiUserId } = req.params;
  try {
    const user = await getUser(wyiUserId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    const { password, ...safeUser } = user as any;

    return res.status(200).json({ success: true, user: safeUser });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
}

export async function getUserStorageHandler(req: Request, res: Response) {
  const { wyiUserId } = req.params;
  if (!wyiUserId) return res.status(400).json({ success: false, message: 'User ID is required.' });

  try {
    const user = await getUser(wyiUserId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    if (user.plan !== 'pro') {
      return res.status(200).json({
        success: true, storageUsed: 0, storageLimit: 0, percentUsed: 0, message: 'Pro only.',
      });
    }

    const result = await db.collection('saved_emails').aggregate([
      { $match: { userId: user._id } },
      { $unwind: { path: '$attachments', preserveNullAndEmptyArrays: true } },
      { $group: { _id: null, totalBytes: { $sum: { $ifNull: ['$attachments.size', 0] } }, emailCount: { $sum: 1 } } },
    ]).toArray();

    const totalBytes = result[0]?.totalBytes || 0;
    const emailCount = result[0]?.emailCount || 0;
    const limitBytes = 5 * 1024 * 1024 * 1024;

    function formatBytes(bytes: number): string {
      if (bytes === 0) return '0 Bytes';
      const k     = 1024;
      const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
      const i     = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    return res.status(200).json({
      success:                  true,
      storageUsed:              totalBytes,
      storageLimit:             limitBytes,
      percentUsed:              (totalBytes / limitBytes * 100).toFixed(2),
      emailCount,
      storageUsedFormatted:     formatBytes(totalBytes),
      storageLimitFormatted:    '5 GB',
      storageRemaining:         limitBytes - totalBytes,
      storageRemainingFormatted: formatBytes(limitBytes - totalBytes),
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
}

export async function saveFcmTokenHandler(req: Request, res: Response) {
  const { wyiUserId, token } = req.body;

  if (!wyiUserId || !token) {
    return res.status(400).json({ success: false, message: 'User ID and Token are required.' });
  }

  try {
    const result = await db.collection('users').updateOne(
      { $or: [{ wyiUserId }, { linkedProviderIds: wyiUserId }] },
      { $set: { fcmToken: token, lastSeenAt: new Date() } },
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    return res.status(200).json({ success: true, message: 'Token saved successfully.' });
  } catch (error) {
    console.error('Error saving FCM token:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
}