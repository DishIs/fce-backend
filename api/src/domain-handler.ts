// Example: In a new file api/src/handlers.ts in your Service API project

import { Request, Response } from 'express';
import { db, IUser } from './mongo'; // Assuming db is exported from your mongo connection file
import { client } from './redis'; // Assuming client is exported
import { promises as dns } from 'dns'; // <-- Import the dns promises API

export async function getDashboardDataHandler(req: Request, res: Response) {
    const { wyiUserId } = req.params;
    if (!wyiUserId) {
        return res.status(400).json({ success: false, message: 'User ID is required.' });
    }

    try {
        const user = await db.collection('users').findOne(
            { wyiUserId },
            { projection: { customDomains: 1, mutedSenders: 1, _id: 0 } }
        );

        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found.' });
        }

        res.json({
            success: true,
            customDomains: user.customDomains || [],
            mutedSenders: user.mutedSenders || [],
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Internal server error.' });
    }
}

export async function deleteDomainHandler(req: Request, res: Response) {
    const { domain, wyiUserId } = req.body;
    if (!domain || !wyiUserId) {
        return res.status(400).json({ success: false, message: 'Domain and User ID are required.' });
    }

    try {
        const usersCollection = db.collection<IUser>('users');

        const updateResult = await usersCollection.updateOne(
            { wyiUserId },
            { $pull: { customDomains: { domain: domain.toLowerCase() } } }
        );


        if (updateResult.modifiedCount === 0) {
            return res.status(404).json({ success: false, message: 'Domain not found for this user.' });
        }

        // Invalidate the Haraka domain cache
        await client.sRem('verified_custom_domains', domain.toLowerCase());

        res.status(200).json({ success: true, message: 'Domain deleted.' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Internal server error.' });
    }
}

export async function unmuteSenderHandler(req: Request, res: Response) {
    const { senderToUnmute, wyiUserId } = req.body;
    if (!senderToUnmute || !wyiUserId) {
        return res.status(400).json({ success: false, message: 'Sender and User ID are required.' });
    }

    client.sRem(`mutelist:${wyiUserId}`, senderToUnmute.toLowerCase())

    res.status(200).json({ success: true, message: 'Sender un-muted.' });
}


export async function verifyDomainHandler(req: Request, res: Response) {
    const { domain, wyiUserId } = req.body;
    if (!domain || !wyiUserId) {
        return res.status(400).json({ success: false, message: 'Domain and User ID are required.' });
    }

    try {
        // 1. Find the user and the specific domain record in the database
        const user = await db.collection('users').findOne(
            { wyiUserId, "customDomains.domain": domain },
            { projection: { "customDomains.$": 1 } }
        );

        const domainRecord = user?.customDomains?.[0];

        if (!domainRecord) {
            return res.status(404).json({ success: false, message: 'Domain not found for this user.' });
        }
        if (domainRecord.verified) {
            return res.status(200).json({ success: true, verified: true, message: 'Domain is already verified.' });
        }

        // 2. Perform the actual DNS lookup for the TXT record
        let txtRecords: string[][] = [];
        try {
            txtRecords = await dns.resolveTxt(domain);
        } catch (dnsError: any) {
            if (dnsError.code === 'ENODATA' || dnsError.code === 'ENOTFOUND') {
                return res.status(400).json({ success: false, verified: false, message: 'TXT record not found. It may not have propagated yet.' });
            }
            console.error(`DNS lookup failed for ${domain}:`, dnsError);
            throw new Error('Could not query DNS records for the domain.');
        }

        // 3. Check if any of the found TXT records match our required value
        const expectedTxtValue = domainRecord.txtRecord;
        const isVerified = txtRecords.flat().includes(expectedTxtValue);

        if (isVerified) {
            // 4. Mark verified in the current user's record
            await db.collection('users').updateOne(
                { wyiUserId, "customDomains.domain": domain },
                { $set: { "customDomains.$.verified": true } }
            );

            // 5. Remove this domain from ALL other users
            await db.collection('users').updateMany(
                { wyiUserId: { $ne: wyiUserId } },
                { $pull: { customDomains: { domain: domain } } as any } // <-- cast to any
            );


            // 6. Add to Redis cache so Haraka can start accepting emails
            await client.sAdd('verified_custom_domains', domain.toLowerCase());

            return res.status(200).json({ success: true, verified: true, message: 'Domain successfully verified!' });
        } else {
            return res.status(400).json({ success: false, verified: false, message: 'TXT record found, but the value does not match. Please double-check.' });
        }

    } catch (error: any) {
        console.error(`Error during domain verification for ${domain}:`, error);
        return res.status(500).json({ success: false, message: error.message || 'Internal server error.' });
    }
}
