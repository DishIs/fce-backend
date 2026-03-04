// v1/api-key-handler.ts
// ─────────────────────────────────────────────────────────────────────────────
//  CRUD handlers for API keys — called from authenticated user dashboard routes.
//  These routes live on the INTERNAL server (protected by internalApiAuth).
//
//  POST   /user/api-keys          → generate
//  GET    /user/api-keys/:userId  → list (prefix only — full key never stored)
//  DELETE /user/api-keys          → revoke
//  POST   /user/api-plan          → set/upgrade API plan for a user
// ─────────────────────────────────────────────────────────────────────────────
import { Request, Response } from 'express';
import crypto from 'crypto';
import { db } from '../mongo';
import { client as redis } from '../redis';
import { getUser } from '../user';
import { ApiPlanName, API_PLANS } from './api-plans';

// ── Generate ──────────────────────────────────────────────────────────────────

export async function generateApiKeyHandler(req: Request, res: Response): Promise<any> {
  const { wyiUserId, name } = req.body;
  if (!wyiUserId) {
    return res.status(400).json({ success: false, message: 'wyiUserId is required.' });
  }

  try {
    const user = await db.collection('users').findOne({
      $or: [{ wyiUserId }, { linkedProviderIds: wyiUserId }],
    });
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    // Enforce 5-key cap per user
    const existingCount = await db.collection('api_keys').countDocuments({
      wyiUserId: user.wyiUserId,
      active: true,
    });
    if (existingCount >= 5) {
      return res.status(400).json({
        success: false,
        message: 'Maximum of 5 active API keys per account. Revoke an existing key first.',
      });
    }

    // Build the raw key — prefix "fce_" + 32 random bytes (hex)
    const rawKey   = `fce_${crypto.randomBytes(32).toString('hex')}`;
    const keyHash  = crypto.createHash('sha256').update(rawKey).digest('hex');
    const keyPrefix = rawKey.slice(0, 12); // "fce_xxxxxxxx" — safe to display

    const newKey = {
      wyiUserId:   user.wyiUserId,
      keyHash,
      keyPrefix,
      name:        name ?? 'Default Key',
      active:      true,
      createdAt:   new Date(),
      lastUsedAt:  null as Date | null,
    };

    await db.collection('api_keys').insertOne(newKey);

    // Return the full key ONCE — we never store it unencrypted
    return res.status(201).json({
      success: true,
      message: 'Store this key securely — it will not be shown again.',
      data: {
        key:       rawKey,        // shown once only
        prefix:    keyPrefix,     // shown in dashboard
        name:      newKey.name,
        createdAt: newKey.createdAt,
      },
    });
  } catch (err) {
    console.error('[generate-api-key]', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
}

// ── List (no secrets) ─────────────────────────────────────────────────────────
// Resolve user by wyiUserId or linkedProviderIds so the same keys are returned
// regardless of which provider id the client sends.

export async function listApiKeysHandler(req: Request, res: Response): Promise<any> {
  const { wyiUserId } = req.params;
  if (!wyiUserId) return res.status(400).json({ success: false, message: 'wyiUserId required.' });

  try {
    const user = await getUser(wyiUserId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    const keys = await db
      .collection('api_keys')
      .find(
        { wyiUserId: user.wyiUserId, active: true },
        // Never expose keyHash
        { projection: { keyHash: 0, _id: 1 } },
      )
      .toArray();

    return res.json({ success: true, data: keys });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
}

// ── Revoke ────────────────────────────────────────────────────────────────────

export async function revokeApiKeyHandler(req: Request, res: Response): Promise<any> {
  const { keyId, wyiUserId } = req.body;
  if (!keyId || !wyiUserId) {
    return res.status(400).json({ success: false, message: 'keyId and wyiUserId are required.' });
  }

  try {
    const user = await getUser(wyiUserId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    const { ObjectId } = await import('mongodb');
    const result = await db.collection('api_keys').updateOne(
      { _id: new ObjectId(keyId), wyiUserId: user.wyiUserId },
      { $set: { active: false, revokedAt: new Date() } },
    );
    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, message: 'Key not found for this user.' });
    }

    // The key hash is unknown here (not returned), but the 60s Redis cache
    // will expire naturally. For instant revocation, flush by pattern if needed.
    return res.json({ success: true, message: 'API key revoked.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
}

// ── Set / Upgrade API plan ────────────────────────────────────────────────────

export async function setApiPlanHandler(req: Request, res: Response): Promise<any> {
  const { wyiUserId, apiPlan, apiCredits } = req.body;

  if (!wyiUserId) {
    return res.status(400).json({ success: false, message: 'wyiUserId is required.' });
  }

  const validPlans: ApiPlanName[] = ['free', 'developer', 'startup', 'growth', 'enterprise'];
  if (apiPlan && !validPlans.includes(apiPlan)) {
    return res.status(400).json({ success: false, message: `Invalid plan. Must be one of: ${validPlans.join(', ')}.` });
  }

  try {
    const updateFields: Record<string, any> = {};
    if (apiPlan !== undefined)     updateFields.apiPlan    = apiPlan;
    if (apiCredits !== undefined)  updateFields.apiCredits = apiCredits;

    if (Object.keys(updateFields).length === 0) {
      return res.status(400).json({ success: false, message: 'Provide apiPlan and/or apiCredits.' });
    }

    const result = await db.collection('users').updateOne(
      { $or: [{ wyiUserId }, { linkedProviderIds: wyiUserId }] },
      { $set: updateFields },
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    // Invalidate any cached API key entries for this user (bust by scanning — acceptable for rare upgrades)
    // In production you may want to store userId → keyHash index for faster invalidation.

    return res.json({
      success: true,
      message: 'API plan updated.',
      plan: apiPlan ?? 'unchanged',
      credits: apiCredits ?? 'unchanged',
    });
  } catch (err) {
    console.error('[set-api-plan]', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
}

// ── Add credits (Paddle/PayPal webhook calls this) ────────────────────────────

export async function addApiCreditsHandler(req: Request, res: Response): Promise<any> {
  const { wyiUserId, creditsToAdd, transactionId } = req.body;

  if (!wyiUserId || !creditsToAdd || !transactionId) {
    return res.status(400).json({ success: false, message: 'wyiUserId, creditsToAdd, transactionId required.' });
  }

  // Idempotency guard — don't double-credit on replay
  const idempKey = `credit_tx:${transactionId}`;
  const already  = await redis.get(idempKey);
  if (already) {
    return res.json({ success: true, message: 'Already processed.', idempotent: true });
  }

  try {
    await db.collection('users').updateOne(
      { $or: [{ wyiUserId }, { linkedProviderIds: wyiUserId }] },
      { $inc: { apiCredits: Number(creditsToAdd) } },
    );

    // Mark transaction as processed for 90 days
    await redis.set(idempKey, '1', { EX: 90 * 24 * 3600 });

    return res.json({ success: true, message: `${creditsToAdd} credits added.` });
  } catch (err) {
    console.error('[add-api-credits]', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
}