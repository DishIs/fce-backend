const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { createServer } = require('http');
const { createClient } = require('redis');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app  = express();
const port = process.env.PORT || 8080;

const redis = createClient({ url: process.env.REDIS_URL || 'redis://redis:6379' });
redis.on('error', (err) => console.log('Redis Client Error', err));
redis.connect();

const FREE_CLUSTER = process.env.FREE_CLUSTER_URL || 'http://api-free:3000';
const PRO_CLUSTER  = process.env.PRO_CLUSTER_URL  || 'http://api-pro:3000';
const JWT_SECRET   = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.warn('[gateway] WARNING: JWT_SECRET not set — all traffic routed to free cluster');
} else {
  console.log('[gateway] JWT_SECRET: set ✓');
}

// ── Rate limit config ──────────────────────────────────────────────────────
// Two sliding windows per request: per-second (burst) + per-minute (sustained).
// nginx is the outermost layer and handles raw floods before we get here.
// This layer adds plan-awareness: pro users get 5× the public API limits.
//
// TWO separate limit buckets:
//
//   PUBLIC_RATE_LIMITS  — /v1/*, /mailbox/*, /domains/*
//     Real API traffic. Tight per-second limits to prevent scraping/abuse.
//     These are the limits API users buy plans for.
//
//   MGMT_RATE_LIMITS    — /user/*, /auth/*, /paddle/*
//     Internal dashboard management calls (api-status, api-keys, payment-logs,
//     settings, inboxes, etc.). These are server-to-server calls signed with
//     the internal API key — NOT public API traffic. Should never be tight.
//     A dashboard page load fires 3 simultaneous requests; we need headroom.
//
const PUBLIC_RATE_LIMITS = {
  anonymous: { perSecond: 2,  perMinute: 30  },
  free:      { perSecond: 4,  perMinute: 80  },
  pro:       { perSecond: 20, perMinute: 400 },
};

const MGMT_RATE_LIMITS = {
  anonymous: { perSecond: 10, perMinute: 120 },
  free:      { perSecond: 20, perMinute: 300 },
  pro:       { perSecond: 50, perMinute: 600 },
};

// Paths routed to PUBLIC_RATE_LIMITS — everything else uses MGMT_RATE_LIMITS
function isPublicApiPath(path) {
  return (
    path.startsWith('/v1/') ||
    path === '/v1' ||
    path.startsWith('/mailbox/') ||
    path.startsWith('/domains') ||
    path === '/domains'
  );
}

// ── Plan detection ─────────────────────────────────────────────────────────
// Called from both Express middleware AND raw 'upgrade' event handlers.
// On upgrade events req is a raw IncomingMessage — req.path, req.query etc.
// do not exist, only req.url and req.headers are guaranteed.
async function determinePlan(req) {
  const headers    = (req && req.headers) || {};
  const url        = (req && (req.url || req.originalUrl)) || '';
  const authHeader = headers.authorization || '';

  if (url.startsWith('/v1/market')) return 'free';

  // JWT — only attempt if secret is set and token contains dots (JWT shape)
  if (JWT_SECRET && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token.includes('.')) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded && decoded.plan) {
          // Any plan that isn't 'free' should go to the pro cluster
          return (decoded.plan !== 'free') ? 'pro' : 'free';
        }
      } catch (_) {
        // expired / malformed — fall through silently
      }
    }
  }

  // Developer API key (fce_xxx — no dots)
  let rawKey = null;
  const qs = req && req.query;
  if (qs && qs.api_key) {
    rawKey = qs.api_key;
  } else if (authHeader.startsWith('Bearer ')) {
    const tok = authHeader.slice(7).trim();
    if (tok && !tok.includes('.')) rawKey = tok;
  }

  if (rawKey) {
    try {
      const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
      const cached  = await redis.get(`api_key_cache:${keyHash}`);
      if (cached) {
        const apiUser = JSON.parse(cached);
        return (apiUser.plan && apiUser.plan !== 'free') ? 'pro' : 'free';
      }
    } catch (_) {
      // Redis miss — default free
    }
  }

  return 'anonymous';
}

// ── Real IP (mirrors abuse-engine.ts priority order) ─────────────────────
function getRealIp(req) {
  const h = (req && req.headers) || {};
  const cf = h['cf-connecting-ip'];
  if (cf && typeof cf === 'string') return cf.trim();
  const xff = h['x-forwarded-for'];
  if (xff) {
    const first = (typeof xff === 'string' ? xff : xff[0]).split(',')[0].trim();
    if (first) return first;
  }
  return (req && req.ip) || 'unknown';
}

// ── Sliding window rate limiter (Redis sorted set) ─────────────────────────
// Each request adds one entry; entries older than the window are evicted first.
// Two windows checked per request: 1s (burst) and 1m (sustained).
// Returns { blocked, retryAfter, limit, window } or { blocked: false }.
async function checkRateLimit(ip, plan, limits) {
  const planLimits = limits[plan] || limits.anonymous;
  const now    = Date.now();

  // Mask to /24 — consistent with abuse-engine.ts
  let ipKey = ip || 'unknown';
  if (ip && ip.includes('.')) {
    ipKey = ip.split('.').slice(0, 3).join('.') + '.0';
  } else if (ip && ip.includes(':')) {
    ipKey = ip.split(':').slice(0, 3).join(':') + '::';
  }

  // bucket suffix keeps public API counters separate from mgmt counters
  // so a burst of dashboard calls never eats into the public API quota
  const bucket = limits === PUBLIC_RATE_LIMITS ? 'pub' : 'mgmt';
  const windows = [
    { key: `rl:gw:${bucket}:${plan}:${ipKey}:1s`, windowMs: 1_000,  limit: planLimits.perSecond },
    { key: `rl:gw:${bucket}:${plan}:${ipKey}:1m`, windowMs: 60_000, limit: planLimits.perMinute },
  ];

  for (const { key, windowMs, limit } of windows) {
    const cutoff = now - windowMs;
    const member = `${now}-${Math.random().toString(36).slice(2)}`;
    try {
      const pipeline = redis.multi();
      pipeline.zRemRangeByScore(key, '-inf', cutoff);
      pipeline.zCard(key);
      pipeline.zAdd(key, { score: now, value: member });
      pipeline.expire(key, Math.ceil(windowMs / 1000) + 1);
      const results = await pipeline.exec();
      const count = results[1]; // count BEFORE adding current request
      if (count >= limit) {
        return { blocked: true, retryAfter: Math.ceil(windowMs / 1000), limit, window: windowMs === 1_000 ? '1s' : '1m' };
      }
    } catch (err) {
      // Redis error → fail open, never block legitimate traffic
      console.error('[gateway] rate limit Redis error:', err.message);
      return { blocked: false };
    }
  }
  return { blocked: false };
}

// ── HTTP middleware ────────────────────────────────────────────────────────

// Step 1: Plan detection
app.use(async (req, res, next) => {
  try {
    const plan = await determinePlan(req);
    req.detectedPlan  = plan;
    req.targetCluster = plan === 'pro' ? PRO_CLUSTER : FREE_CLUSTER;
    delete req.headers['x-plan'];
    req.headers['x-derived-plan'] = plan;
    next();
  } catch (_) {
    req.detectedPlan  = 'anonymous';
    req.targetCluster = FREE_CLUSTER;
    delete req.headers['x-plan'];
    req.headers['x-derived-plan'] = 'anonymous';
    next();
  }
});

// Step 2: Rate limiting (HTTP only — WS upgrade path is untouched below)
app.use(async (req, res, next) => {
  const path = req.path || '';

  // Bypass: health checks
  if (path === '/health') return next();

  // Bypass: WS upgrade requests — these never reach Express middleware anyway
  // (they go straight to server 'upgrade' event), but guard defensively
  if (req.headers.upgrade && req.headers.upgrade.toLowerCase() === 'websocket') return next();

  const plan   = req.detectedPlan || 'anonymous';
  const ip     = getRealIp(req);

  // Use tight limits for public API paths, generous limits for internal mgmt
  const limitSet = isPublicApiPath(path) ? PUBLIC_RATE_LIMITS : MGMT_RATE_LIMITS;
  const result   = await checkRateLimit(ip, plan, limitSet);

  if (result.blocked) {
    res.set({
      'Retry-After':      String(result.retryAfter),
      'X-RateLimit-Limit': String(result.limit),
      'X-RateLimit-Window': result.window,
      'X-RateLimit-Plan':   plan,
    });
    return res.status(429).json({
      success: false,
      error:   'too_many_requests',
      code:    plan === 'pro' ? 'RATE_LIMIT_PRO' : 'RATE_LIMIT_FREE',
      message: plan === 'pro'
        ? `Rate limit exceeded. Retry in ${result.retryAfter}s.`
        : `Rate limit exceeded. Upgrade to Pro for higher limits. Retry in ${result.retryAfter}s.`,
      retryAfter: result.retryAfter,
      plan,
    });
  }

  next();
});

// Step 3: Internal API key check (unchanged)
app.use((req, res, next) => {
  const path = req.path || '';
  const isInternal =
    !path.startsWith('/v1') &&
    !path.startsWith('/domains') &&
    path !== '/health';

  if (isInternal && req.headers['x-internal-api-key']) {
    if (req.headers['x-internal-api-key'] !== process.env.INTERNAL_API_KEY) {
      return res.status(401).send('Unauthorized');
    }
  }
  next();
});

// ── Proxy ──────────────────────────────────────────────────────────────────
const proxy = createProxyMiddleware({
  router:       (req) => req.targetCluster || FREE_CLUSTER,
  changeOrigin: true,
  ws:           true,
  on: {
    error: (err, req, res) => {
      if (res && typeof res.writeHead === 'function' && !res.headersSent) {
        res.writeHead(502);
        res.end('Bad Gateway');
      }
    },
  },
});

app.use('/', proxy);

// ── Server ─────────────────────────────────────────────────────────────────
const server = createServer(app);

// ── WebSocket upgrade — UNCHANGED from working version ────────────────────
// Do NOT add rate limiting here — it breaks the handshake.
// nginx handles WS connection-rate limiting at the outer layer.
server.on('upgrade', (req, socket, head) => {
  if (!req || !socket) return;

  determinePlan(req)
    .then((plan) => {
      const target = plan === 'pro' ? PRO_CLUSTER : FREE_CLUSTER;
      if (req.headers) {
        req.headers['x-derived-plan'] = plan;
        delete req.headers['x-plan'];
      }
      proxy.upgrade(req, socket, head, { target });
    })
    .catch(() => {
      try {
        proxy.upgrade(req, socket, head, { target: FREE_CLUSTER });
      } catch (_) {
        socket.destroy();
      }
    });
});

server.listen(port, () => {
  console.log(`API Gateway listening on port ${port}`);
  console.log(`FREE → ${FREE_CLUSTER} | PRO → ${PRO_CLUSTER}`);
  console.log(`Public API limits:  anon=${JSON.stringify(PUBLIC_RATE_LIMITS.anonymous)} free=${JSON.stringify(PUBLIC_RATE_LIMITS.free)} pro=${JSON.stringify(PUBLIC_RATE_LIMITS.pro)}`);
  console.log(`Mgmt limits:        anon=${JSON.stringify(MGMT_RATE_LIMITS.anonymous)} free=${JSON.stringify(MGMT_RATE_LIMITS.free)} pro=${JSON.stringify(MGMT_RATE_LIMITS.pro)}`);
});