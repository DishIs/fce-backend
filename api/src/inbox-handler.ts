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
        // First, find the user to determine their plan
        const user = await db.collection('users').findOne({ wyiUserId: wyiUserId });

        if (!user) {
            return res.status(404).json({ success: false, message: "User not found." });
        }

        let updateOperation;
        let successMessage: string;

        // Implement plan-based logic
        if (user.plan === 'pro') {
            // For pro users, append the new inbox to the list if it doesn't already exist
            updateOperation = { $addToSet: { inboxes: normalizedInbox } };
            successMessage = "Inbox added successfully.";
        } else {
            // For free users, replace the existing inbox list with the new one
            updateOperation = { $set: { inboxes: [normalizedInbox] } };
            successMessage = "Inbox has been updated.";
        }

        // Execute the determined update operation
        const result = await db.collection('users').updateOne(
            { wyiUserId: wyiUserId }, // Find the user by their ID
            updateOperation
        );

        if (result.modifiedCount === 0) {
            // This can happen if a pro user tries to add an existing inbox,
            // or a free user sets the same inbox they already have.
            // In either case, it's not an error.
            if (user.plan === 'pro' && user.inboxes.includes(normalizedInbox)) {
                 return res.status(200).json({ success: true, message: "Inbox was already associated with this account." });
            }
             if (user.plan === 'free' && user.inboxes[0] === normalizedInbox) {
                 return res.status(200).json({ success: true, message: "This is already your active inbox." });
            }
        }
        
        // If the update was successful (or no change was needed for a free user)
        return res.status(200).json({ success: true, message: successMessage });

    } catch (error) {
        console.error("Error in addInboxHandler:", error);
        return res.status(500).json({ success: false, message: "An internal server error occurred." });
    }
}