'use strict';

const { createClient } = require('redis');
const { MongoClient } = require('mongodb');

// --- Module-level variables for persistent connections ---
let redisClient;
let mongoClient;
let db;
let plugin;
let freeDomains = []; // Cache for your free domains

exports.register = function () {
    plugin = this;
    plugin.load_ini();
    plugin.register_hook('rcpt', 'check_custom_domain');
};

exports.load_ini = function () {
    plugin.cfg = plugin.config.get('queue.redis.ini', 'ini');
    
    // --- Load the list of free domains directly from the other plugin's config ---
    // This is the key to avoiding duplicate configuration.
    freeDomains = plugin.config.get('host_list', 'list').map(d => d.toLowerCase());
    plugin.loginfo(`Loaded ${freeDomains.length} free domains to ignore: ${freeDomains.join(', ')}`);

    const redisUrl = plugin.cfg.main.redis_url || 'redis://localhost:6379';
    const mongoUrl = plugin.cfg.main.mongo_url || 'mongodb://localhost:27017';
    const dbName = plugin.cfg.main.mongo_db_name || 'freecustomemail';
    
    if (!redisClient) {
        redisClient = createClient({ url: redisUrl });
        redisClient.on('error', (err) => plugin.logerror(`Redis Client Error: ${err}`));
        redisClient.connect().catch(err => plugin.logerror(`Redis connect failed: ${err}`));
    }
    if (!mongoClient) {
        mongoClient = new MongoClient(mongoUrl);
        mongoClient.connect()
            .then(() => {
                db = mongoClient.db(dbName);
                plugin.loginfo('Successfully connected to MongoDB for custom domains.');
            })
            .catch(err => {
                plugin.logcrit(`FATAL: Could not connect to MongoDB. Plugin will not work. Error: ${err}`);
            });
    }
};

exports.shutdown = function () {
    if (redisClient) redisClient.quit();
    if (mongoClient) mongoClient.close();
};

exports.check_custom_domain = async function (next, connection, params) {
    const recipient = params[0];
    const domain = recipient.host.toLowerCase();

    // --- Optimization: Check against the free domain list first ---
    // If the domain is one of our own free-tier domains, this plugin has no opinion.
    // It will be handled by the next plugin in the chain (rcpt_to.in_host_list).
    if (freeDomains.includes(domain)) {
        connection.logdebug(plugin, `Domain ${domain} is a free host, deferring to next plugin.`);
        return next();
    }

    // If we've reached here, the domain is NOT a free domain. It might be a pro domain.
    connection.logdebug(plugin, `Domain ${domain} is not a free host, checking for pro status.`);

    // --- Ensure our database connections are live ---
    if (!db || !redisClient.isOpen) {
        plugin.logerror("A database connection is not available for custom domain check.");
        return next(DENYSOFT, "Backend service is temporarily unavailable.");
    }
    
    const customDomainsSetKey = 'verified_custom_domains';

    try {
        // 1. Check Redis cache for the pro domain. This is for high performance.
        const isMember = await redisClient.sIsMember(customDomainsSetKey, domain);
        if (isMember) {
            connection.logdebug(plugin, `Domain ${domain} found in pro domain Redis cache. Accepting.`);
            return next(OK); // Accept the recipient and stop further rcpt checks.
        }

        // 2. If not in cache, query MongoDB for verified pro domains.
        const userWithDomain = await db.collection('users').findOne({
            "customDomains.domain": domain,
            "customDomains.verified": true,
            "plan": "pro"
        });

        if (userWithDomain) {
            connection.logdebug(plugin, `Domain ${domain} verified in MongoDB. Accepting and caching.`);
            
            // Add to Redis cache for all subsequent requests.
            redisClient.sAdd(customDomainsSetKey, domain).catch(err => {
                plugin.logerror(`Failed to cache domain ${domain} in Redis: ${err}`);
            });

            return next(OK); // Accept the recipient.
        }

        // 3. Final Decision: The domain is not a free domain AND not a pro domain.
        // Let the next plugin (rcpt_to.in_host_list) handle the final DENY.
        connection.logdebug(plugin, `Domain ${domain} is not a pro custom domain. Deferring.`);
        next();

    } catch (e) {
        plugin.logerror(`Error checking custom domain ${domain}: ${e.stack}`);
        next(DENYSOFT, 'Temporary backend error during address validation.');
    }
};