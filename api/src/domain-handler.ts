// Example: In a new file api/src/handlers.ts in your Service API project

import { Request, Response } from 'express';
import { db, IUser } from './mongo'; // Assuming db is exported from your mongo connection file
import { client } from './redis'; // Assuming client is exported
import { promises as dns, MxRecord } from 'dns'; // <-- Import MxRecord from the main module

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
        const isTxtVerified = txtRecords.flat().includes(expectedTxtValue);

        if (!isTxtVerified) {
            return res.status(400).json({ success: false, verified: false, message: 'TXT record found, but the value does not match. Please double-check.' });
        }

        // 4. NEW: Verify MX record points to our server
        let mxRecords: MxRecord[] = []; // <-- Use the imported type here
        try {
            mxRecords = await dns.resolveMx(domain);
        } catch (mxError: any) {
            if (mxError.code === 'ENODATA' || mxError.code === 'ENOTFOUND') {
                return res.status(400).json({ 
                    success: false, 
                    verified: false, 
                    message: 'MX record not found. Please add an MX record pointing to mx.freecustom.email' 
                });
            }
            console.error(`MX lookup failed for ${domain}:`, mxError);
            throw new Error('Could not query MX records for the domain.');
        }

        // Check if at least one MX record points to our server
        const expectedMxHost = domainRecord.mxRecord || 'mx.freecustom.email';
        const isMxValid = mxRecords.some(mx => 
            mx.exchange.toLowerCase() === expectedMxHost.toLowerCase() ||
            mx.exchange.toLowerCase().endsWith('.freecustom.email')
        );

        if (!isMxValid) {
            return res.status(400).json({ 
                success: false, 
                verified: false, 
                message: `MX record must point to ${expectedMxHost}. Current MX records: ${mxRecords.map(m => m.exchange).join(', ')}` 
            });
        }

        // 5. Both TXT and MX verified - mark as verified
        await db.collection('users').updateOne(
            { wyiUserId, "customDomains.domain": domain },
            { $set: { "customDomains.$.verified": true } }
        );

        // 6. Remove this domain from ALL other users
        await db.collection('users').updateMany(
            { wyiUserId: { $ne: wyiUserId } },
            { $pull: { customDomains: { domain: domain } } as any } // <-- cast to any
        );

        // 7. Add to Redis cache so Haraka can start accepting emails
        await client.sAdd('verified_custom_domains', domain.toLowerCase());

        return res.status(200).json({ success: true, verified: true, message: 'Domain successfully verified! Both TXT and MX records are correct.' });

    } catch (error: any) {
        console.error(`Error during domain verification for ${domain}:`, error);
        return res.status(500).json({ success: false, message: error.message || 'Internal server error.' });
    }
}