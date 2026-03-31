// api/src/v1/routes/mcp.ts
// ─────────────────────────────────────────────────────────────────────────────
// MCP Premium Interface Layer for AI-native email workflows
// This module provides endpoints specifically tailored for the MCP server.
// It includes strict rate-limiting, custom billing multipliers, and
// aggregated functions (e.g., create-and-wait-otp).
// ─────────────────────────────────────────────────────────────────────────────
import { Router, Request, Response, NextFunction } from 'express';
import { db } from '../../config/mongo';
import { client as redis } from '../../config/redis';
import { getDomainEntry } from '../../services/domain-registry';
import { getInbox } from '../../services/mailbox';
import { apiPlanToInternalPlan } from '../api-plans';
import { globalEvents } from '../../services/events';

const router = Router();

// ── MCP Access Gating ────────────────────────────────────────────────────────
router.use((req: Request, res: Response, next: NextFunction): any => {
  const apiUser = req.apiUser!;
  
  if (!apiUser.planConfig.features.mcpEnabled) {
    return res.status(403).json({
      error: 'MCP not available on your plan',
      upgrade: 'Growth required'
    });
  }
  next();
});

// ── MCP Specific Rate Limiting (Ops/Min) ─────────────────────────────────────
router.use(async (req: Request, res: Response, next: NextFunction): Promise<any> => {
  const apiUser = req.apiUser!;
  const limits = apiUser.planConfig.features.mcpLimits;
  
  if (limits.opsPerMinute > 0) {
    const minuteKey = `mcp:rl:m:${apiUser.userId}:${Math.floor(Date.now() / 60000)}`;
    try {
      const ops = await redis.incr(minuteKey);
      if (ops === 1) await redis.expire(minuteKey, 120);
      
      if (ops > limits.opsPerMinute) {
        return res.status(429).json({
          success: false,
          error: 'mcp_rate_limit_exceeded',
          message: `MCP limit of ${limits.opsPerMinute} ops/min exceeded.`,
        });
      }
    } catch (err) {
      console.error('[mcp-ratelimit] Redis error:', err);
    }
  }
  next();
});

// Helper: Apply API Quota Multiplier Cost
// We subtract 1 because the global apiRateLimit middleware already charged 1
async function applyMcpCost(userId: string, multiplier: number) {
  if (multiplier <= 1) return;
  const monthKey = `rl:m:${userId}:${new Date().toISOString().slice(0, 7)}`;
  await redis.incrBy(monthKey, multiplier - 1).catch(() => {});
}

/**
 * Confirm that the given inbox is registered under this API user.
 */
async function assertOwned(userId: string, inbox: string): Promise<boolean> {
  const cacheKey = `inbox_owned:${userId}:${inbox}`;
  try {
    const hit = await redis.get(cacheKey);
    if (hit !== null) return hit === '1';
  } catch (_) { }

  const user = await db.collection('users').findOne({
    wyiUserId: userId,
    apiInboxes: inbox.toLowerCase(),
  });
  const owned = !!user;
  redis.set(cacheKey, owned ? '1' : '0', { EX: 30 }).catch(() => {});
  return owned;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. GET /v1/mcp/inboxes/:address/messages (Get latest email) - 2x Cost
// ─────────────────────────────────────────────────────────────────────────────
router.get('/inboxes/:inbox/messages/latest', async (req: Request, res: Response): Promise<any> => {
  const inbox = req.params.inbox.toLowerCase();
  const apiUser = req.apiUser!;

  if (!(await assertOwned(apiUser.userId, inbox))) {
    return res.status(403).json({ success: false, error: 'inbox_not_owned' });
  }

  await applyMcpCost(apiUser.userId, 2);

  try {
    const internalPlan = apiPlanToInternalPlan(apiUser.plan);
    const messages = (await getInbox(inbox, internalPlan)) as any[];
    
    if (messages.length === 0) {
      return res.json({ success: true, message: 'No messages found', data: null });
    }
    
    // Simplification for AI: only return essential fields to fit in context window
    const latest = messages[0];
    return res.json({
      success: true,
      data: {
        id: latest.id,
        from: latest.from,
        subject: latest.subject,
        date: latest.date,
        text: latest.text || 'No text content', // simplified
        otp: latest.otp,
        verificationLink: latest.verificationLink
      }
    });
  } catch {
    return res.status(500).json({ success: false, error: 'server_error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. GET /v1/mcp/inboxes/:address/otp (Extract OTP) - 3x Cost
// ─────────────────────────────────────────────────────────────────────────────
router.get('/inboxes/:inbox/otp', async (req: Request, res: Response): Promise<any> => {
  const inbox = req.params.inbox.toLowerCase();
  const apiUser = req.apiUser!;

  if (!(await assertOwned(apiUser.userId, inbox))) {
    return res.status(403).json({ success: false, error: 'inbox_not_owned' });
  }

  await applyMcpCost(apiUser.userId, 3);

  try {
    const internalPlan = apiPlanToInternalPlan(apiUser.plan);
    const messages = (await getInbox(inbox, internalPlan)) as any[];

    const withOtp = messages
      .filter(m => m.otp && !['__DETECTED__', '__UPGRADE_REQUIRED__'].includes(m.otp))
      .sort((a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime());

    if (!withOtp.length) {
      return res.json({ success: true, otp: null, message: 'No OTP found in recent messages.' });
    }

    const latest = withOtp[0];
    return res.json({
      success: true,
      otp: latest.otp,
      email_id: latest.id,
      from: latest.from,
      subject: latest.subject,
      timestamp: new Date(latest.date).getTime(),
      verification_link: latest.verificationLink ?? null,
    });
  } catch {
    return res.status(500).json({ success: false, error: 'server_error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. POST /v1/mcp/create-and-wait-otp (GOLD FEATURE) - 5x Cost
// ─────────────────────────────────────────────────────────────────────────────
router.post('/create-and-wait-otp', async (req: Request, res: Response): Promise<any> => {
  const apiUser = req.apiUser!;
  const domain = req.body.domain || 'ditube.info';
  
  // Create random address
  const randomPrefix = Math.random().toString(36).substring(2, 10);
  const inbox = `${randomPrefix}@${domain}`;

  await applyMcpCost(apiUser.userId, 5);

  // Validate Domain (simplified checks for MCP premium layer)
  const registryEntry = getDomainEntry(domain);
  if (!registryEntry) {
    return res.status(400).json({ success: false, error: 'invalid_domain', message: 'Use standard provided domain like ditube.info' });
  }

  try {
    // Register Inbox
    await db.collection('users').updateOne(
      { wyiUserId: apiUser.userId },
      { $addToSet: { apiInboxes: inbox } },
    );

    const internalPlan = apiPlanToInternalPlan(apiUser.plan);
    await redis.set(
      `user_data_cache:${inbox}`,
      JSON.stringify({ plan: internalPlan, userId: apiUser.userId, isVerified: false }),
      { EX: 3600 },
    );

    // Now WAIT for OTP
    const eventName = `mailbox:${inbox}`;
    let timeout = parseInt(req.body.timeout || '45', 10);
    if (isNaN(timeout) || timeout < 10) timeout = 45;
    if (timeout > 60) timeout = 60; // Max 60s cap for HTTP connections

    let timer: NodeJS.Timeout;

    const onNewEmail = (event: any) => {
      // Check if it has OTP
      if (event.otp && !['__DETECTED__', '__UPGRADE_REQUIRED__'].includes(event.otp)) {
        clearTimeout(timer);
        globalEvents.off(eventName, onNewEmail);
        if (!res.headersSent) {
          res.json({
            success: true,
            inbox: inbox,
            otp: event.otp,
            verification_link: event.verificationLink || null,
            from: event.from,
            subject: event.subject
          });
        }
      }
    };

    timer = setTimeout(() => {
      globalEvents.off(eventName, onNewEmail);
      if (!res.headersSent) {
        res.json({ success: false, inbox: inbox, message: 'Timeout reached, no OTP received' });
      }
    }, timeout * 1000);

    globalEvents.on(eventName, onNewEmail);

    req.on('close', () => {
      globalEvents.off(eventName, onNewEmail);
      clearTimeout(timer);
    });

  } catch {
    return res.status(500).json({ success: false, error: 'server_error' });
  }
});

export default router;
