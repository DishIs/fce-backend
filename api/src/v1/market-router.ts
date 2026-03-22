import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { client as redis } from '../config/redis';
import inboxRouter from './routes/inbox';
import domainsRouter from './routes/domains';
import customDomainsRouter from './routes/custom-domains';
import webhookRouter from './routes/webhooks';

const marketRouter = Router();

// ── Auth & Rate Limit for Marketplaces ───────────────────────────────────────
// In this lane, we do NOT use IP fingerprinting because Marketplaces proxy traffic.
// We identify users via x-marketplace-key or x-rapidapi-key.
// All marketplace users are treated as 'free' for feature usage (no OTP, no Websockets).

async function marketAuth(req: Request, res: Response, next: NextFunction) {
  const marketSecret = req.header('x-marketplace-secret') || req.header('x-rapidapi-proxy-secret');
  const marketKey = req.header('x-marketplace-key') || req.header('x-rapidapi-key') || req.header('x-apihub-key');
  
  if (!process.env.MARKETPLACE_SECRET) {
    console.warn('MARKETPLACE_SECRET is not set in environment.');
  }

  // Validate the secret provided by the marketplace gateway
  if (process.env.MARKETPLACE_SECRET && marketSecret !== process.env.MARKETPLACE_SECRET) {
    return res.status(401).json({
      success: false,
      error: 'unauthorized',
      message: 'Invalid or missing marketplace secret header.'
    });
  }

  if (!marketKey) {
    return res.status(401).json({
      success: false,
      error: 'unauthorized',
      message: 'Missing marketplace identity key header (e.g., x-rapidapi-key).'
    });
  }

  // Map to internal userContext structure so downstream routers work seamlessly
  req.userContext = {
    userId: `market:${marketKey}`,
    fingerprint: `market_${crypto.createHash('md5').update(marketKey).digest('hex')}`,
    ip: 'marketplace-proxy',
    plan: 'free' 
  };

  // Check Rate Limits based on Marketplace key (instead of IP)
  const minuteKey = `rl:market:${req.userContext.fingerprint}:${new Date().toISOString().slice(0, 16)}`;
  
  // Track distributed sharing pattern
  const rawIp = req.ip || req.headers['x-forwarded-for'] || 'unknown-ip';
  const ua = req.headers['user-agent'] || 'unknown-ua';
  const uaHash = crypto.createHash('md5').update(`${rawIp}|${ua}`).digest('hex');
  const sharedKeyTracker = `abuse:market_shares:${marketKey}`;
  const sharedKeyUaTracker = `abuse:market_uas:${marketKey}`;

  try {
    const current = await redis.incr(minuteKey);
    if (current === 1) {
      await redis.expire(minuteKey, 120);
    }

    if (process.env.DISABLE_MARKETPLACE_LIMITS !== 'true' && current > 100) {
      return res.status(429).json({
        success: false,
        error: 'too_many_requests',
        message: 'Upgrade for higher limits at freecustom.email'
      });
    }

    // Record IP/UA footprint and check for shared keys
    const added = await redis.sAdd(sharedKeyTracker, rawIp);
    const addedUa = await redis.sAdd(sharedKeyUaTracker, uaHash);
    
    if (added) await redis.expire(sharedKeyTracker, 3600);
    if (addedUa) await redis.expire(sharedKeyUaTracker, 3600);
    
    const [distinctIps, distinctUas] = await Promise.all([
      redis.sCard(sharedKeyTracker),
      redis.sCard(sharedKeyUaTracker)
    ]);

    // Shared key detection (require both IP diversity AND UA diversity to avoid punishing NATs)
    if (process.env.DISABLE_MARKETPLACE_LIMITS !== 'true' && distinctIps > 10 && distinctUas > 5) {
      const delayMs = 200 + Math.random() * 600;
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    
    // Set mock apiUser so /v1 sub-routers (like inboxes) function
    // For marketplace users, advanced features are completely disabled.
    req.apiUser = {
      userId: req.userContext.userId!,
      apiKeyId: 'market-key',
      plan: 'free',
      planConfig: {
        name: 'free',
        label: 'Free Tier',
        price: 0,
        rateLimit: { requestsPerSecond: 5, requestsPerMonth: 10000 },
        features: { 
          otpExtraction: false, 
          attachments: false, 
          maxAttachmentSizeMb: 0, 
          customDomains: false, 
          websocket: false, 
          maxWsConnections: 0 
        }
      },
      credits: 0
    };
    res.set({
      'x-ratelimit-limit': '100',
      'x-ratelimit-remaining': (100 - current).toString(),
    });
    next();
  } catch (err) {
    console.error('Marketplace Rate Limiting Error:', err);
    res.status(500).json({ success: false, error: 'internal_error', message: 'Rate limit verification failed' });
  }
}

marketRouter.use(marketAuth);

// Mount the same sub-routers
marketRouter.use('/inboxes', inboxRouter);
marketRouter.use('/domains', domainsRouter);
marketRouter.use('/custom-domains', customDomainsRouter);
marketRouter.use('/webhooks', webhookRouter);

// Catch-all for market routes so they don't fall through to /v1
marketRouter.use((req, res) => {
  res.status(404).json({ success: false, error: 'not_found', message: 'Marketplace route not found' });
});

export default marketRouter;
