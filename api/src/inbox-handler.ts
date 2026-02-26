// /api/src/inbox-handler.ts
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
    // UPDATED: Check for user via wyiUserId OR linkedProviderIds
    const user = await db.collection('users').findOne({ 
      $or: [
        { wyiUserId: wyiUserId },
        { linkedProviderIds: wyiUserId }
      ]
    });

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    let inboxes: string[] = Array.isArray(user.inboxes)
      ? user.inboxes.map(i => i.toLowerCase())
      : [];

    let successMessage: string;

    // --- Logic to update DB Inboxes List ---
    if (user.plan === 'pro') {
      // Pro users keep all inboxes, just move current to top
      inboxes = inboxes.filter(i => i !== normalizedInbox);
      inboxes.unshift(normalizedInbox);
      successMessage = "Inbox added successfully.";
    } else {
      // Free users only get 1 active inbox
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
        { _id: user._id }, // Use _id obtained from findOne for safety
        { $set: { inboxes } }
      );
    }

    // --- FIXED: Redis cache handling ---
    if (client.isOpen) {
      const ttl = parseInt(process.env.PLAN_CACHE_TTL || "3600", 10);
       
      const userData = {
        plan: user.plan,
        userId: user._id,
        isVerified: false // Default for standard inboxes
      };

      // FIX: Loop through ALL inboxes in the array and update cache.
      for (const inbox of inboxes) {
        const inboxCacheKey = `user_data_cache:${inbox}`;
        await client.set(inboxCacheKey, JSON.stringify(userData), { EX: ttl });
      }
    }

    return res.status(200).json({ success: true, message: successMessage });

  } catch (error) {
    console.error("Error in addInboxHandler:", error);
    return res.status(500).json({ success: false, message: "An internal server error occurred." });
  }
}
