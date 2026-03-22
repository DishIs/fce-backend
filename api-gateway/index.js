const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { createClient } = require('redis');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 8080;

// Connect to Redis
const redis = createClient({ url: process.env.REDIS_URL || 'redis://redis:6379' });
redis.on('error', (err) => console.log('Redis Client Error', err));
redis.connect();

// Pro and Free Backend Targets
const FREE_CLUSTER = process.env.FREE_CLUSTER_URL || 'http://api-free:3000';
const PRO_CLUSTER = process.env.PRO_CLUSTER_URL || 'http://api-pro:3000';
const JWT_SECRET = process.env.JWT_SECRET;

async function determinePlan(req) {
  // 3. Marketplace check
  if (req.path.startsWith('/v1/market')) {
    // Treat marketplace users as free cluster, unless we introduce paid marketplace plans
    return 'free';
  }

  // 2. Check JWT Token (Frontend users)
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      if (decoded && decoded.plan) {
        return decoded.plan === 'pro' ? 'pro' : 'free';
      }
    } catch (error) {
      console.warn("JWT verification failed in gateway:", error.message);
    }
  }

  // 3. Check Developer API Key (for /v1 endpoints)
  let rawKey = null;
  if (req.query.api_key) {
    rawKey = req.query.api_key;
  } else if (authHeader && authHeader.startsWith('Bearer ') && !authHeader.includes('.')) {
      // If it's a bearer token but not a JWT (doesn't contain dots), it might be an API key
      rawKey = authHeader.substring(7).trim();
  }

  if (rawKey) {
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const cacheKey = `api_key_cache:${keyHash}`;
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        const apiUser = JSON.parse(cached);
        return apiUser.plan === 'free' ? 'free' : 'pro';
      }
    } catch (e) {
      console.error('Redis error during gateway plan check', e);
    }
  }

  // Default to free
  return 'free';
}

app.use(async (req, res, next) => {
  try {
    const plan = await determinePlan(req);
    req.targetCluster = plan === 'pro' ? PRO_CLUSTER : FREE_CLUSTER;
    
    // Pass the securely derived plan down to the backend nodes
    // Remove any user-supplied x-plan to prevent spoofing
    delete req.headers['x-plan'];
    req.headers['x-derived-plan'] = plan;
    
    next();
  } catch (err) {
    req.targetCluster = FREE_CLUSTER;
    delete req.headers['x-plan'];
    req.headers['x-derived-plan'] = 'free';
    next();
  }
});

app.use((req, res, next) => {
  // We only enforce internal API key check for specific internal endpoints
  // if the frontend relies on x-internal-api-key for them.
  // We do NOT want to block public API or public frontend endpoints.
  const isInternalEndpoint = !req.path.startsWith('/v1') && !req.path.startsWith('/domains') && req.path !== '/health';
  
  if (isInternalEndpoint && req.headers['x-internal-api-key']) {
     if (req.headers['x-internal-api-key'] !== process.env.INTERNAL_API_KEY) {
         return res.status(401).send('Unauthorized');
     }
  }
  next();
});

app.use('/', createProxyMiddleware({
  router: function(req) {
    return req.targetCluster;
  },
  changeOrigin: true,
  ws: true, // Enable WebSockets proxy
}));

app.listen(port, () => {
  console.log(`API Gateway listening on port ${port}`);
  console.log(`Routing to: FREE (${FREE_CLUSTER}) | PRO (${PRO_CLUSTER})`);
});
