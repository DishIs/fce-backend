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

  return 'free';
}

// ── HTTP middleware ────────────────────────────────────────────────────────
app.use(async (req, res, next) => {
  try {
    const plan = await determinePlan(req);
    req.targetCluster = plan === 'pro' ? PRO_CLUSTER : FREE_CLUSTER;
    delete req.headers['x-plan'];
    req.headers['x-derived-plan'] = plan;
    next();
  } catch (_) {
    req.targetCluster = FREE_CLUSTER;
    delete req.headers['x-plan'];
    req.headers['x-derived-plan'] = 'free';
    next();
  }
});

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
});