// /api/src/inbox-handler.ts
import { Request, Response } from 'express';
import { db } from './mongo';
import { client } from './redis';
import { DOMAINS, FREE_DOMAINS, PRO_DOMAINS, getDomainEntry } from './domain-registry';

export async function addInboxHandler(req: Request, res: Response): Promise<any> {
  const { wyiUserId, inboxName, inbox } = req.body;
  const inboxValue = inboxName ?? inbox;

  if (!wyiUserId || !inboxValue) {
    return res.status(400).json({ success: false, message: "User ID and inbox name are required." });
  }

  const normalizedInbox = String(inboxValue).trim().toLowerCase();

  if (!/^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/.test(normalizedInbox)) {
    return res.status(400).json({
      success: false,
      message: "Please enter a valid email address (e.g. myinbox@ditube.info).",
    });
  }

  const domain = normalizedInbox.split('@')[1];

  try {
    const user = await db.collection('users').findOne({
      $or: [
        { wyiUserId },
        { linkedProviderIds: wyiUserId },
      ],
    });

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    const isPro = user.plan === 'pro';

    // ── Domain tier check ──────────────────────────────────────────────────
    // Check if the domain is a registered platform domain and what tier it is.
    const registryEntry = getDomainEntry(domain);

    if (registryEntry) {
      // It's one of our platform domains — enforce tier gating.
      if (registryEntry.tier === 'pro' && !isPro) {
        return res.status(403).json({
          success: false,
          message: `@${domain} is a Pro-tier domain. Upgrade to Pro to use it, or choose a free domain (e.g. @ditube.info).`,
          upgrade_url: 'https://freecustom.email/pricing',
        });
      }
    } else {
      // Not a platform domain — must be a user custom domain.
      // Only pro users can use custom domains, and it must be verified.
      if (!isPro) {
        return res.status(403).json({
          success: false,
          message: `Domain "${domain}" is not supported. Use an address at one of our provided domains (e.g. @ditube.info). Custom domains require a Pro plan.`,
          upgrade_url: 'https://freecustom.email/pricing',
        });
      }

      const isVerifiedCustom = Array.isArray(user.customDomains) &&
        user.customDomains.some(
          (d: { domain: string; verified?: boolean }) =>
            d.domain.toLowerCase() === domain && d.verified === true,
        );

      if (!isVerifiedCustom) {
        return res.status(400).json({
          success: false,
          message: `Domain "${domain}" is not verified. Add and verify it in Settings before using it.`,
        });
      }
    }

    // ── Inbox list update ──────────────────────────────────────────────────
    const rawInboxes = Array.isArray(user.inboxes) ? user.inboxes : [];
    let inboxes: string[] = rawInboxes
      .filter((i): i is string => typeof i === 'string')
      .map(i => i.toLowerCase());

    let successMessage: string;

    if (isPro) {
      inboxes = inboxes.filter(i => i !== normalizedInbox);
      inboxes.unshift(normalizedInbox);
      successMessage = "Inbox added successfully.";
    } else {
      if (inboxes[0] === normalizedInbox) {
        return res.status(200).json({ success: true, message: "This is already your active inbox." });
      }
      inboxes = [normalizedInbox];
      successMessage = "Inbox has been updated.";
    }

    const inboxesChanged = JSON.stringify(inboxes) !== JSON.stringify(user.inboxes);
    if (inboxesChanged) {
      await db.collection('users').updateOne(
        { _id: user._id },
        { $set: { inboxes } },
      );
    }

    // ── Redis cache ────────────────────────────────────────────────────────
    if (client.isOpen) {
      try {
        const ttl = parseInt(process.env.PLAN_CACHE_TTL || "3600", 10);
        const userData = {
          plan: user.plan,
          userId: user._id?.toString?.() ?? String(user._id),
          isVerified: false,
        };
        for (const addr of inboxes) {
          await client.set(`user_data_cache:${addr}`, JSON.stringify(userData), { EX: ttl });
        }
      } catch (redisErr) {
        console.error("Redis cache update failed (inbox still saved):", redisErr);
      }
    }

    return res.status(200).json({ success: true, message: successMessage });
  } catch (error) {
    console.error("Error in addInboxHandler:", error);
    return res.status(500).json({ success: false, message: "An internal server error occurred." });
  }
}