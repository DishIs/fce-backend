// /home/dit/maildrop/api/src/inbox-handler.ts
import { Request, Response } from 'express';
import { db } from './mongo';

export async function addInboxHandler(req: Request, res: Response): Promise<any> {
    const { wyiUserId, inboxName } = req.body;

    if (!wyiUserId || !inboxName) {
        return res.status(400).json({ success: false, message: "User ID and inbox name are required." });
    }

    const normalizedInbox = inboxName.toLowerCase();

    try {
        // Fetch the user first
        const user = await db.collection('users').findOne({ wyiUserId });

        if (!user) {
            return res.status(404).json({ success: false, message: "User not found." });
        }

        let inboxes: string[] = Array.isArray(user.inboxes) ? [...user.inboxes] : [];
        let successMessage: string;

        if (user.plan === 'pro') {
            // Remove if already exists to avoid duplicates
            inboxes = inboxes.filter(i => i !== normalizedInbox);
            // Insert at beginning
            inboxes.unshift(normalizedInbox);
            successMessage = "Inbox added successfully.";
        } else {
            // Free user only has one inbox — always overwrite
            inboxes = [normalizedInbox];
            successMessage = "Inbox has been updated.";
        }

        // Update DB
        const result = await db.collection('users').updateOne(
            { wyiUserId },
            { $set: { inboxes } }
        );

        if (result.modifiedCount === 0) {
            if (user.plan === 'pro' && user.inboxes[0] === normalizedInbox) {
                return res.status(200).json({ success: true, message: "Inbox was already at the top." });
            }
            if (user.plan === 'free' && user.inboxes[0] === normalizedInbox) {
                return res.status(200).json({ success: true, message: "This is already your active inbox." });
            }
        }

        return res.status(200).json({ success: true, message: successMessage });

    } catch (error) {
        console.error("Error in addInboxHandler:", error);
        return res.status(500).json({ success: false, message: "An internal server error occurred." });
    }
}
