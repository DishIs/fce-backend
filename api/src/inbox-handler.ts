// /api/src/inbox-handler.ts
import { Request, Response } from 'express';
import { db } from './mongo';
import { client } from './redis';
import { DOMAINS } from './domains';

export async function addInboxHandler(req: Request, res: Response): Promise<any> {
  const { wyiUserId, inboxName, inbox } = req.body;
  const inboxValue = inboxName ?? inbox;

  if (!wyiUserId || !inboxValue) {
    return res.status(400).json({ success: false, message: "User ID and inbox name are required." });
  }

  const normalizedInbox = String(inboxValue).trim().toLowerCase();

  // Basic email format check
  if (!/^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/.test(normalizedInbox)) {
    return res.status(400).json({
      success: false,
      message: "Please enter a valid email address (e.g. myinbox@ditube.info).",
    });
  }

  const domain = normalizedInbox.split('@')[1];

  try {
    // UPDATED: Check for user via wyiUserId OR linkedProviderIds
    const user = await db.collection('users').findOne({
      $or: [
        { wyiUserId: wyiUserId },
        { linkedProviderIds: wyiUserId },
      ],
    });

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    // Allowed domains: our provided domains + user's verified custom domains (pro only)
    const allowedDomains = new Set<string>(DOMAINS.map((d: string) => d.toLowerCase()));
    if (user.plan === 'pro' && Array.isArray(user.customDomains)) {
      user.customDomains
        .filter((d: { verified?: boolean }) => d.verified === true)
        .forEach((d: { domain: string }) => allowedDomains.add(d.domain.toLowerCase()));
    }
    if (!allowedDomains.has(domain)) {
      return res.status(400).json({
        success: false,
        message: `Domain "${domain}" is not supported. Use an address at one of our provided domains (e.g. @ditube.info) or add and verify your custom domain in Settings.`,
      });
    }

    const rawInboxes = Array.isArray(user.inboxes) ? user.inboxes : [];
    let inboxes: string[] = rawInboxes
      .filter((i): i is string => typeof i === 'string')
      .map(i => i.toLowerCase());

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

    // Redis cache (non-fatal: don't fail the request if Redis is down)
    if (client.isOpen) {
      try {
        const ttl = parseInt(process.env.PLAN_CACHE_TTL || "3600", 10);
        const userData = {
          plan: user.plan,
          userId: user._id?.toString?.() ?? String(user._id),
          isVerified: false,
        };
        for (const addr of inboxes) {
          const key = `user_data_cache:${addr}`;
          await client.set(key, JSON.stringify(userData), { EX: ttl });
        }
      } catch (redisErr) {
        console.error("Error updating inbox cache (inbox still saved):", redisErr);
      }
    }

    return res.status(200).json({ success: true, message: successMessage });
  } catch (error) {
    console.error("Error in addInboxHandler:", error);
    return res.status(500).json({
      success: false,
      message: "An internal server error occurred.",
    });
  }
}
