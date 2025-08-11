// api/src/user.ts
import { db } from './mongo';
import { client as redisClient } from './redis';
import { IUser } from './mongo';
import { v4 as uuidv4 } from 'uuid';
import { Request, Response } from 'express';

// This function assumes the frontend has authenticated the user and provides the wyiUserId
// In a real app, you would verify a JWT or access token here.
async function getUser(wyiUserId: string): Promise<IUser | null> {
    return await db.collection<IUser>('users').findOne({ wyiUserId });
}

// Handler to add a custom domain for a pro user
export async function addDomainHandler(req: any, res: any) {
    const { wyiUserId, domain } = req.body;

    // Normalize domain to lowercase for consistency
    const normalizedDomain = domain?.trim().toLowerCase();

    if (!normalizedDomain) {
        return res.status(400).json({ success: false, message: 'Domain is required.' });
    }

    const user = await getUser(wyiUserId);

    if (!user || user.plan !== 'pro') {
        return res.status(403).json({ success: false, message: 'Permission denied.' });
    }

    // 1. Check if this domain is already verified for another user
    const existing = await db.collection('users').findOne({
        "customDomains.domain": normalizedDomain,
        "customDomains.verified": true,
        wyiUserId: { $ne: wyiUserId } // exclude current user
    });

    if (existing) {
        return res.status(409).json({
            success: false,
            message: 'This domain is already verified for another account.'
        });
    }

    // 2. Check if this user already has the domain (verified or not)
    const alreadyExists = await db.collection('users').findOne({
        _id: user._id,
        "customDomains.domain": normalizedDomain
    });

    if (alreadyExists) {
        return res.status(409).json({
            success: false,
            message: 'You have already added this domain.'
        });
    }

    // 3. Create TXT verification record
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

    res.status(200).json({
        success: true,
        message: 'Domain added. Please add TXT record for verification.',
        data: newDomain
    });
}


// Handler for a user to mute a sender
export async function muteSenderHandler(req: any, res: any) {
    const { wyiUserId, senderToMute } = req.body;
    const user = await getUser(wyiUserId);

    if (!user || user.plan !== 'pro') {
        return res.status(403).json({ success: false, message: 'Permission denied.' });
    }

    await db.collection('users').updateOne(
        { _id: user._id },
        { $addToSet: { mutedSenders: senderToMute.toLowerCase() } }
    );

    // Update the cached mute list for this user
    const userMuteListKey = `mutelist:${user.wyiUserId}`;
    await redisClient.sAdd(userMuteListKey, senderToMute.toLowerCase());

    res.status(200).json({ success: true, message: 'Sender has been muted.' });
}

/**
 * --- NEW HANDLER ---
 * Handles a pro user un-muting a specific sender address.
 */
export async function unmuteSenderHandler(req: Request, res: Response) {
    const { wyiUserId, senderToUnmute } = req.body;

    if (!wyiUserId || !senderToUnmute) {
        return res.status(400).json({ success: false, message: 'User ID and sender address are required.' });
    }

    const user = await getUser(wyiUserId);

    // Although anyone can attempt this, we check for the user to ensure the operation is authorized.
    if (!user) {
        return res.status(404).json({ success: false, message: 'User not found.' });
    }

    // You could also enforce that only pro users can unmute, for consistency.
    if (user.plan !== 'pro') {
        return res.status(403).json({ success: false, message: 'Permission denied.' });
    }

    const sender = senderToUnmute.toLowerCase();

    try {
        // Remove from the user's document in MongoDB
        await db.collection('users').updateOne(
            { wyiUserId },
            { $pull: { mutedSenders: sender } }
        );

        // Remove from the user's specific mute list in Redis
        const userMuteListKey = `mutelist:${wyiUserId}`;
        await redisClient.sRem(userMuteListKey, sender);

        res.status(200).json({ success: true, message: 'Sender has been un-muted.' });

    } catch (error) {
        console.error(`Error un-muting sender for user ${wyiUserId}:`, error);
        res.status(500).json({ success: false, message: 'An internal error occurred.' });
    }
}



export async function upsertUserHandler(req: Request, res: Response) {
    const { wyiUserId, email, name, plan } = req.body;

    if (!wyiUserId || !email || !name || !plan) {
        return res.status(400).json({ success: false, message: 'Missing required user data.' });
    }

    try {
        const usersCollection = db.collection('users');

        const updateDoc = {
            $set: {
                wyiUserId,
                email,
                name,
                plan,
                lastLoginAt: new Date(),
            },
            $setOnInsert: {
                createdAt: new Date(),
                inboxes: [],
                customDomains: [],
                mutedSenders: [],
            }
        };

        const filter = { wyiUserId };
        const options = { upsert: true };

        await usersCollection.updateOne(filter, updateDoc, options);

        res.status(200).json({ success: true, message: 'User synchronized successfully.' });
    } catch (error) {
        console.error('Error during user upsert:', error);
        res.status(500).json({ success: false, message: 'Internal server error during user synchronization.' });
    }
}

// Add a new handler to get all custom domains for a user
export async function getDomainsHandler(req: Request, res: Response) {
    const { wyiUserId } = req.params;

    if (!wyiUserId) {
        return res.status(400).json({ success: false, message: 'User ID is required.' });
    }

    try {
        const user = await db.collection('users').findOne(
            { wyiUserId },
            { projection: { customDomains: 1, _id: 0 } }
        );

        if (!user) {
            // Return an empty array if the user is not found, which is a valid state
            return res.status(200).json({ success: true, domains: [] });
        }

        res.status(200).json({ success: true, domains: user.customDomains || [] });
    } catch (error) {
        console.error('Error fetching user domains:', error);
        res.status(500).json({ success: false, message: 'Internal server error.' });
    }
}

export async function getUserProfileHandler(req: Request, res: Response) {
    const { wyiUserId } = req.params;

    if (!wyiUserId) {
        return res.status(400).json({ success: false, message: 'User ID is required.' });
    }

    try {
        const user = await db.collection('users').findOne(
            { wyiUserId: wyiUserId },
            {
                // Exclude sensitive or internal fields if necessary
                projection: { _id: 0, password: 0 }
            }
        );

        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found.' });
        }

        return res.status(200).json({ success: true, user: user });

    } catch (error) {
        console.error(`API Error fetching profile for user ${wyiUserId}:`, error);
        return res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
}
