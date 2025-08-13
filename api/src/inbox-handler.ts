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

        // --- Redis cache handling ---
        if (client.isOpen) {
            const ttl = parseInt(process.env.PLAN_CACHE_TTL || "3600", 10);

            // 1. Delete all old cache keys for previous inboxes
            if (Array.isArray(user.inboxes) && user.inboxes.length > 0) {
                const oldKeys = user.inboxes.map(i => `user_data_cache:${i.toLowerCase()}`);
                if (oldKeys.length > 0) {
                    await client.del(oldKeys);
                }
            }

            // 2. Set new cache entry for the current inbox
            const cacheKey = `user_data_cache:${normalizedInbox}`;
            const userData = {
                plan: user.plan,
                userId: user._id,
                isVerified: false
            };
            await client.set(cacheKey, JSON.stringify(userData), { EX: ttl });
        }

        return res.status(200).json({ success: true, message: successMessage });

    } catch (error) {
        console.error("Error in addInboxHandler:", error);
        return res.status(500).json({ success: false, message: "An internal server error occurred." });
    }
}
