// api/src/user.ts
import { db } from './mongo';
import { client as redisClient } from './redis';
import { IUser } from './mongo';
import { v4 as uuidv4 } from 'uuid';

// This function assumes the frontend has authenticated the user and provides the wyiUserId
// In a real app, you would verify a JWT or access token here.
async function getUser(wyiUserId: string): Promise<IUser | null> {
    return await db.collection<IUser>('users').findOne({ wyiUserId });
}

// Handler to add a custom domain for a pro user
export async function addDomainHandler(req: any, res: any) {
    const { wyiUserId, domain } = req.body; // Assume frontend sends this
    const user = await getUser(wyiUserId);

    if (!user || user.plan !== 'pro') {
        return res.status(403).json({ success: false, message: 'Permission denied.' });
    }

    const txtRecord = `freecustomemail-verification=${uuidv4()}`;
    await db.collection('users').updateOne(
        { _id: user._id },
        {
            $addToSet: {
                customDomains: {
                    domain,
                    verified: false,
                    mxRecord: 'mx.freecustom.email', // Your MX record
                    txtRecord
                }
            }
        }
    );
    
    // Invalidate domain cache
    await redisClient.del('custom_domains');

    res.status(200).json({ success: true, message: 'Domain added. Please add TXT record for verification.' });
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

// We'd also add handlers for verifying domains (checking DNS TXT records) and un-muting senders.