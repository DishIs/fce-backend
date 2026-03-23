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

// ── Rate limit config per plan ─────────────────────────────────────────────
//
// Two windows enforced simultaneously:
//   1. Per-second  — burst protection  (sliding window in Redis)
//   2. Per-minute  — sustained rate    (sliding window in Redis)
//
// Anonymous users get the tightest limits since they're unauthenticated and
// share infrastructure with everyone else.
//
// Pro users get 10x the per-second and per-minute limits. In practice a human
// user never comes close — these only kick in if someone is scripting.
//
// The /v1/* developer API has its own monthly quota system in the abuse engine;
// these gateway limits are the first line of defence before traffic even hits
// the app layer.
//
// Paths that bypass rate limiting entirely:
//   - /health  — load balancer probes
//   - WebSocket upgrades — long-lived connections, not request-based
//
const RATE_LIMITS = {
  anonymous: { perSecond: 2,  perMinute: 30  },
  free:      { perSecond: 4,  perMinute: 80  },
  pro:       { perSecond: 20, perMinute: 400 },
};

// Paths that are exempt from rate limiting (internal tools, health checks)
const RATE_LIMIT_BYPASS_PATHS = new Set(['/health']);

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
          return decoded.plan === 'pro' ? 'pro' : 'free';
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

// ── Sliding window rate limiter ────────────────────────────────────────────
//
// Uses a Redis sorted set where each member is `${timestamp}-${random}`
// and the score is the timestamp in ms. On every request:
//   1. Remove members older than the window
//   2. Count remaining members
//   3. If count >= limit → reject with 429
//   4. Otherwise add current request and set TTL
//
// This is an exact sliding window — more accurate than the token bucket or
// fixed window approaches, with minimal Redis overhead (2 round-trips via
// pipeline).
//
// Key format: rl:gw:{plan}:{ip}:{window}
// e.g.        rl:gw:free:1.2.3.0:1s
//
async function checkRateLimit(ip, plan) {
  const limits = RATE_LIMITS[plan] || RATE_LIMITS.anonymous;
  const now    = Date.now();

  // Mask IP to /24 subnet — same as abuse engine — to handle proxies
  // that cycle through a small pool of IPs within the same /24.
  let ipKey = ip || 'unknown';
  if (ip && ip.includes('.')) {
    ipKey = ip.split('.').slice(0, 3).join('.') + '.0';
  } else if (ip && ip.includes(':')) {
    ipKey = ip.split(':').slice(0, 3).join(':') + '::';
  }

  const windows = [
    { key: `rl:gw:${plan}:${ipKey}:1s`,  windowMs: 1_000,  limit: limits.perSecond },
    { key: `rl:gw:${plan}:${ipKey}:1m`,  windowMs: 60_000, limit: limits.perMinute },
  ];

  for (const { key, windowMs, limit } of windows) {
    const cutoff  = now - windowMs;
    const member  = `${now}-${Math.random().toString(36).slice(2)}`;

    try {
      const pipeline = redis.multi();
      pipeline.zRemRangeByScore(key, '-inf', cutoff);  // evict expired entries
      pipeline.zCard(key);                              // count current window
      pipeline.zAdd(key, { score: now, value: member });
      pipeline.expire(key, Math.ceil(windowMs / 1000) + 1);
      const results = await pipeline.exec();

      // results[1] is the count BEFORE we added the new member
      const count = results[1];
      if (count >= limit) {
        // Return which window was hit so we can set the right Retry-After
        return {
          blocked: true,
          retryAfter: Math.ceil(windowMs / 1000),
          limit,
          window: windowMs === 1_000 ? '1s' : '1m',
        };
      }
    } catch (err) {
      // Redis failure → fail open (don't block legitimate traffic)
      console.error('[gateway] rate limit Redis error:', err.message);
      return { blocked: false };
    }
  }

  return { blocked: false };
}

// ── Real IP extraction ─────────────────────────────────────────────────────
// Mirrors the same priority order as abuse-engine.ts so rate limit keys
// are consistent with abuse engine fingerprints.
function getRealIp(req) {
  const headers = (req && req.headers) || {};

  const cfIp = headers['cf-connecting-ip'];
  if (cfIp && typeof cfIp === 'string') return cfIp.trim();

  const xff = headers['x-forwarded-for'];
  if (xff) {
    const first = (typeof xff === 'string' ? xff : xff[0]).split(',')[0].trim();
    if (first) return first;
  }

  return (req && req.ip) || 'unknown';
}

// ── HTTP middleware ────────────────────────────────────────────────────────

// Step 1: Plan detection — runs first, sets x-derived-plan for downstream
app.use(async (req, res, next) => {
  try {
    const plan = await determinePlan(req);
    req.detectedPlan   = plan;
    req.targetCluster  = plan === 'pro' ? PRO_CLUSTER : FREE_CLUSTER;
    delete req.headers['x-plan'];
    req.headers['x-derived-plan'] = plan;
    next();
  } catch (_) {
    req.detectedPlan   = 'anonymous';
    req.targetCluster  = FREE_CLUSTER;
    delete req.headers['x-plan'];
    req.headers['x-derived-plan'] = 'anonymous';
    next();
  }
});

// Step 2: Rate limiting — runs after plan detection so we know the tier
app.use(async (req, res, next) => {
  const path = req.path || '';

  // Bypass: health checks and internal-only paths
  if (RATE_LIMIT_BYPASS_PATHS.has(path)) return next();

  // Bypass: WebSocket upgrade requests are long-lived, not per-request
  if (req.headers.upgrade?.toLowerCase() === 'websocket') return next();

  const plan = req.detectedPlan || 'anonymous';
  const ip   = getRealIp(req);

  const result = await checkRateLimit(ip, plan);

  if (result.blocked) {
    // Set standard rate limit headers so clients can back off intelligently
    res.set({
      'Retry-After':               String(result.retryAfter),
      'X-RateLimit-Limit':         String(result.limit),
      'X-RateLimit-Window':        result.window,
      'X-RateLimit-Plan':          plan,
    });

    return res.status(429).json({
      success: false,
      error:   'too_many_requests',
      // Different messages per plan — frontend uses this to decide which toast to show
      message: plan === 'pro'
        ? `Rate limit exceeded. Please slow down — retry in ${result.retryAfter}s.`
        : `Rate limit exceeded. Upgrade to Pro for higher limits. Retry in ${result.retryAfter}s.`,
      retryAfter: result.retryAfter,
      plan,
      // Hint field for free users — picked up by classifyApiError in email-box.tsx
      // to trigger the upgrade toast with /pricing link
      code: plan !== 'pro' ? 'RATE_LIMIT_FREE' : 'RATE_LIMIT_PRO',
    });
  }

  next();
});

// Step 3: Internal API key check
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

// ── WebSocket upgrade ──────────────────────────────────────────────────────
// WS upgrades bypass Express middleware so we do rate limiting inline here.
// We use a lighter per-IP connection rate limit (not per-request) since
// WS connections are long-lived — limiting connection establishment is enough.
server.on('upgrade', (req, socket, head) => {
  if (!req || !socket) return;

  determinePlan(req)
    .then(async (plan) => {
      const target = plan === 'pro' ? PRO_CLUSTER : FREE_CLUSTER;
      if (req.headers) {
        req.headers['x-derived-plan'] = plan;
        delete req.headers['x-plan'];
      }

      // Light rate limit on WS connection establishment (not per-message)
      // Pro: 20 new connections/min, Free/anon: 5 new connections/min
      const ip      = getRealIp(req);
      const wsLimit = plan === 'pro' ? 20 : 5;
      const wsKey   = `rl:gw:ws:${plan}:${ip}`;
      try {
        const count = await redis.incr(wsKey);
        if (count === 1) await redis.expire(wsKey, 60);
        if (count > wsLimit) {
          socket.write('HTTP/1.1 429 Too Many Requests\r\nContent-Length: 0\r\n\r\n');
          socket.destroy();
          return;
        }
      } catch (_) {
        // Redis error → fail open
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
  console.log(`Rate limits: anon=${JSON.stringify(RATE_LIMITS.anonymous)} free=${JSON.stringify(RATE_LIMITS.free)} pro=${JSON.stringify(RATE_LIMITS.pro)}`);
});