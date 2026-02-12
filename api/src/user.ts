import { db } from './mongo';
import { client as redisClient } from './redis';
import { IUser, IUserSettings, ISubscription, IPaymentLog } from './mongo';
import { v4 as uuidv4 } from 'uuid';
import { Request, Response } from 'express';

// ── Updated getUser() helper ───────────────────────────────────────────────
// Now checks both wyiUserId (primary) AND linkedProviderIds (aliases).
// Use this everywhere in user.ts instead of a direct findOne({ wyiUserId }).

async function getUser(userId: string): Promise<IUser | null> {
    return await db.collection<IUser>('users').findOne({
        $or: [
            { wyiUserId: userId },
            { linkedProviderIds: userId },
        ]
    });
}


// ------------------------------------------------------------------
// STATUS & SETTINGS HANDLERS
// ------------------------------------------------------------------

/**
 * Returns the user's current status, specifically their plan.
 * Used by NextAuth 'jwt' callback to refresh session data.
 */
export async function getUserStatusHandler(req: Request, res: Response) {
    const { userId } = req.body; // Sent as { userId: token.id }

    if (!userId) {
        return res.status(400).json({ success: false, message: 'User ID required' });
    }

    try {
        const user = await getUser(userId);
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        // Return critical session data
        return res.status(200).json({ 
            success: true, 
            plan: user.plan,
            subscriptionStatus: user.subscription?.status 
        });
    } catch (error) {
        console.error("Error getting user status:", error);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
}

/**
 * Updates user preferences/settings (Theme, Shortcuts, Notifications).
 */
export async function updateSettingsHandler(req: Request, res: Response) {
    const { wyiUserId, ...settings } = req.body; // Expect body to contain settings keys directly or nested

    if (!wyiUserId) {
        return res.status(400).json({ success: false, message: 'User ID required' });
    }

    try {
        // Sanitize: ensure we don't accidentally save the ID as a setting
        const settingsToUpdate = { ...settings } as IUserSettings;

        await db.collection('users').updateOne(
            { wyiUserId },
            { $set: { settings: settingsToUpdate } }
        );

        return res.status(200).json({ success: true, message: 'Settings updated' });
    } catch (error) {
        console.error("Error updating settings:", error);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
}

/**
 * Retrieves user settings.
 */
export async function getSettingsHandler(req: Request, res: Response) {
    const { wyiUserId } = req.body; // Or query param depending on implementation

    if (!wyiUserId) {
        return res.status(400).json({ success: false, message: 'User ID required' });
    }

    try {
        const user = await getUser(wyiUserId);
        return res.status(200).json({ success: true, settings: user?.settings || {} });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Server error' });
    }
}

// ------------------------------------------------------------------
// SUBSCRIPTION & BILLING HANDLERS
// ------------------------------------------------------------------

/**
 * Called by Next.js API after validating a PayPal subscription.
 * Upgrades the user to PRO and logs the subscription.
 */
export async function upgradeUserSubscriptionHandler(req: Request, res: Response) {
    const { userId, subscriptionId, planId, status, startTime, payer } = req.body;

    if (!userId || !subscriptionId) {
        return res.status(400).json({ success: false, message: 'Invalid payload' });
    }

    try {
        const subscriptionData: ISubscription = {
            provider: 'paypal',
            subscriptionId,
            planId,
            status: status || 'ACTIVE',
            startTime,
            payerEmail: payer?.email,
            payerName: payer?.name,
            lastUpdated: new Date()
        };

        const paymentLog: IPaymentLog = {
            userId,
            transactionType: 'subscription_created',
            provider: 'paypal',
            subscriptionId,
            details: req.body,
            createdAt: new Date()
        };

        // 1. Log the transaction
        await db.collection('payment_logs').insertOne(paymentLog);

        // 2. Update User: Set Plan to PRO and save subscription details
        const updateResult = await db.collection('users').updateOne(
            { wyiUserId: userId },
            { 
                $set: { 
                    plan: 'pro',
                    subscription: subscriptionData
                } 
            }
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

// ------------------------------------------------------------------
// EXISTING HANDLERS (UPDATED)
// ------------------------------------------------------------------
// api/src/user.ts — replace upsertUserHandler with this version
//
// This handles the case where a user signs in with a different provider
// but uses the same email address. Instead of creating a duplicate account,
// it links the new provider ID to the existing account.

export async function upsertUserHandler(req: Request, res: Response) {
    const { wyiUserId, email, name, plan } = req.body;

    if (!wyiUserId || !email || !name) {
        return res.status(400).json({ success: false, message: 'Missing required user data.' });
    }

    try {
        const usersCollection = db.collection('users');

        // ── 1. Check if this exact userId already exists ──────────────────
        const exactMatch = await usersCollection.findOne({ wyiUserId });

        if (exactMatch) {
            // User exists under this provider ID — just refresh login metadata.
            // Guard against downgrading a pro user.
            const planToSet = exactMatch.plan === 'pro' ? 'pro' : (plan || 'free');

            await usersCollection.updateOne(
                { wyiUserId },
                {
                    $set: {
                        email,
                        name,
                        plan: planToSet,
                        lastLoginAt: new Date(),
                    }
                }
            );
            return res.status(200).json({ success: true, message: 'User synchronized successfully.' });
        }

        // ── 2. No exact match — check if another account uses this email ──
        // This happens when a user signs in with a different provider (e.g.,
        // previously used WYI, now signing in with Google using same email).
        const emailMatch = await usersCollection.findOne({
            email: email.toLowerCase().trim(),
        });

        if (emailMatch) {
            // Found an existing account with this email.
            // Add the new provider ID as an alias instead of creating a duplicate.
            await usersCollection.updateOne(
                { _id: emailMatch._id },
                {
                    $set: {
                        lastLoginAt: new Date(),
                        // Optionally update name if it was empty
                        ...(emailMatch.name ? {} : { name }),
                    },
                    // Track all provider IDs this user has used
                    $addToSet: {
                        linkedProviderIds: wyiUserId,
                    }
                }
            );

            // IMPORTANT: The JWT token.id will be this new wyiUserId, but
            // the DB record lives under the original ID. To make /user/status
            // lookups work, we need to also match on linkedProviderIds.
            // See the updated getUser() helper below.

            return res.status(200).json({
                success: true,
                message: 'Linked to existing account.',
                // Send back the canonical ID so the frontend can use it
                canonicalId: emailMatch.wyiUserId,
            });
        }

        // ── 3. Truly new user — create a fresh record ─────────────────────
        await usersCollection.updateOne(
            { wyiUserId },
            {
                $set: {
                    wyiUserId,
                    email: email.toLowerCase().trim(),
                    name,
                    plan: plan || 'free',
                    lastLoginAt: new Date(),
                },
                $setOnInsert: {
                    createdAt: new Date(),
                    inboxes: [],
                    inboxHistory: [],
                    customDomains: [],
                    mutedSenders: [],
                    settings: {},
                    linkedProviderIds: [wyiUserId],
                }
            },
            { upsert: true }
        );

        return res.status(200).json({ success: true, message: 'User created successfully.' });

    } catch (error) {
        console.error('Error during user upsert:', error);
        return res.status(500).json({ success: false, message: 'Internal server error.' });
    }
}



// Handler to add a custom domain for a pro user
export async function addDomainHandler(req: any, res: any) {
    const { wyiUserId, domain } = req.body;
    const normalizedDomain = domain?.trim().toLowerCase();

    if (!normalizedDomain) return res.status(400).json({ success: false, message: 'Domain is required.' });

    const user = await getUser(wyiUserId);

    if (!user || user.plan !== 'pro') {
        return res.status(403).json({ success: false, message: 'Permission denied.' });
    }

    const existing = await db.collection('users').findOne({
        "customDomains.domain": normalizedDomain,
        "customDomains.verified": true,
        wyiUserId: { $ne: wyiUserId }
    });

    if (existing) {
        return res.status(409).json({ success: false, message: 'This domain is already verified for another account.' });
    }

    const alreadyExists = await db.collection('users').findOne({
        _id: user._id,
        "customDomains.domain": normalizedDomain
    });

    if (alreadyExists) {
        return res.status(409).json({ success: false, message: 'You have already added this domain.' });
    }

    const txtRecord = `freecustomemail-verification=${uuidv4()}`;
    const newDomain = {
        domain: normalizedDomain,
        verified: false,
        mxRecord: 'mx.freecustom.email',
        txtRecord
    };

    await db.collection('users').updateOne(
        { _id: user._id },
        { $addToSet: { customDomains: newDomain } }
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
        { $addToSet: { mutedSenders: senderToMute.toLowerCase() } }
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
    await db.collection('users').updateOne({ wyiUserId }, { $pull: { mutedSenders: sender } });
    await redisClient.sRem(`mutelist:${wyiUserId}`, sender);

    res.status(200).json({ success: true, message: 'Sender has been un-muted.' });
}

export async function getDomainsHandler(req: Request, res: Response) {
    const { wyiUserId } = req.params;
    if (!wyiUserId) return res.status(400).json({ success: false, message: 'User ID is required.' });

    try {
        const user = await db.collection('users').findOne({ wyiUserId }, { projection: { customDomains: 1, _id: 0 } });
        res.status(200).json({ success: true, domains: user?.customDomains || [] });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Internal server error.' });
    }
}

export async function getUserProfileHandler(req: Request, res: Response) {
    const { wyiUserId } = req.params;
    try {
        const user = await db.collection('users').findOne({ wyiUserId }, { projection: { _id: 0, password: 0 } });
        if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
        return res.status(200).json({ success: true, user: user });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
}

export async function getUserStorageHandler(req: Request, res: Response) {
    const { wyiUserId } = req.params;
    if (!wyiUserId) return res.status(400).json({ success: false, message: 'User ID is required.' });

    try {
        const user = await db.collection('users').findOne({ wyiUserId });
        if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

        if (user.plan !== 'pro') {
            return res.status(200).json({ 
                success: true, storageUsed: 0, storageLimit: 0, percentUsed: 0, message: 'Pro only.'
            });
        }

        const result = await db.collection('saved_emails').aggregate([
            { $match: { userId: user._id } },
            { $unwind: { path: "$attachments", preserveNullAndEmptyArrays: true } },
            { $group: { _id: null, totalBytes: { $sum: { $ifNull: ["$attachments.size", 0] } }, emailCount: { $sum: 1 } } }
        ]).toArray();

        const totalBytes = result[0]?.totalBytes || 0;
        const emailCount = result[0]?.emailCount || 0;
        const limitBytes = 5 * 1024 * 1024 * 1024; // 5GB

        function formatBytes(bytes: number): string {
            if (bytes === 0) return '0 Bytes';
            const k = 1024;
            const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
        }

        return res.status(200).json({
            success: true,
            storageUsed: totalBytes,
            storageLimit: limitBytes,
            percentUsed: (totalBytes / limitBytes * 100).toFixed(2),
            emailCount: emailCount,
            storageUsedFormatted: formatBytes(totalBytes),
            storageLimitFormatted: '5 GB',
            storageRemaining: limitBytes - totalBytes,
            storageRemainingFormatted: formatBytes(limitBytes - totalBytes)
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
}