import { Request, Response } from 'express';
import { db } from './mongo';
import { client } from './redis';

export async function addInboxHandler(req: Request, res: Response): Promise<any> {
    const { wyiUserId, inboxName } = req.body;

    if (!wyiUserId || !inboxName) {
        return res.status(400).json({ success: false, message: "User ID and inbox name are required." });
    }

    const normalizedInbox = inboxName.trim().toLowerCase();

    try {
        const user = await db.collection('users').findOne({ wyiUserId });

        if (!user) {
            return res.status(404).json({ success: false, message: "User not found." });
        }

        let inboxes: string[] = Array.isArray(user.inboxes)
            ? user.inboxes.map(i => i.toLowerCase())
            : [];

        let successMessage: string;

        if (user.plan === 'pro') {
            inboxes = inboxes.filter(i => i !== normalizedInbox);
            inboxes.unshift(normalizedInbox);
            successMessage = "Inbox added successfully.";
        } else {
            if (inboxes[0] === normalizedInbox) {
                return res.status(200).json({
                    success: true,
                    message: "This is already your active inbox."
                });
            }
            inboxes = [normalizedInbox];
            successMessage = "Inbox has been updated.";
        }

        // Update DB if inbox list changed
        const inboxesChanged = JSON.stringify(inboxes) !== JSON.stringify(user.inboxes);
        if (inboxesChanged) {
            await db.collection('users').updateOne(
                { wyiUserId },
                { $set: { inboxes } }
            );
        }

        // --- FIXED: Redis cache handling ---
        if (client.isOpen) {
            const ttl = parseInt(process.env.PLAN_CACHE_TTL || "3600", 10);

            // FIX: For FREE users, we DON'T delete old caches anymore
            // This prevents emails from being saved to the wrong plan namespace
            // when users switch between inboxes
            
            // OPTION 1 (Recommended): Keep cache for the current inbox only
            // This works because getUserData will fall back to MongoDB and find the user
            // as long as the inbox is in their inboxes array
            
            // Set cache entry for the current inbox
            const cacheKey = `user_data_cache:${normalizedInbox}`;
            const userData = {
                plan: user.plan,
                userId: user._id,
                isVerified: false
            };
            await client.set(cacheKey, JSON.stringify(userData), { EX: ttl });

            // CRITICAL: For free users, keep cache alive for ALL their inboxes
            // even though they only have one "active" inbox in the UI
            // This ensures incoming emails always use the correct plan
            if (user.plan === 'free' && Array.isArray(user.inboxes)) {
                for (const inbox of user.inboxes) {
                    const inboxCacheKey = `user_data_cache:${inbox.toLowerCase()}`;
                    await client.set(inboxCacheKey, JSON.stringify(userData), { EX: ttl });
                }
            }
        }

        return res.status(200).json({ success: true, message: successMessage });

    } catch (error) {
        console.error("Error in addInboxHandler:", error);
        return res.status(500).json({ success: false, message: "An internal server error occurred." });
    }
}