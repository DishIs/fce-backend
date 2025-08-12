// /home/dit/maildrop/api/src/inbox-handler.ts
import { Request, Response } from 'express';
import { db } from './mongo';
import { ObjectId } from 'mongodb';

export async function addInboxHandler(req: Request, res: Response): Promise<any> {
    const { wyiUserId, inboxName } = req.body;

    if (!wyiUserId || !inboxName) {
        return res.status(400).json({ success: false, message: "User ID and inbox name are required." });
    }


    try {

        // Use $addToSet to add the inbox to the user's array.
        // This is safe and prevents duplicates.
        const result = await db.collection('users').updateOne(
            { wyiUserId: wyiUserId }, // Find the user by their ID
            { $addToSet: { inboxes: inboxName.toLowerCase() } } // Add the new inbox
        );

        if (result.modifiedCount === 0) {
            // This could mean the user wasn't found, or the inbox was already in their list.
            const userExists = await db.collection('users').findOne({ wyiUserId: wyiUserId });
            if (!userExists) {
                return res.status(404).json({ success: false, message: "User not found." });
            }
            return res.status(200).json({ success: true, message: "Inbox was already associated with this account." });
        }

        return res.status(200).json({ success: true, message: "Inbox added successfully." });

    } catch (error) {
        console.error("Error adding inbox:", error);
        return res.status(500).json({ success: false, message: "An internal error occurred." });
    }
}