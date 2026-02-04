// /home/dit/maildrop/smtp-fast/src/plugins/rcpt_to_mongo.js

'use strict';

const { createClient } = require('redis');
const { MongoClient } = require('mongodb');
const dns = require('dns').promises;

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
    plugin.cfg = plugin.config.get('redis.ini', 'ini');

    // --- Load the list of free domains directly from the other plugin's config ---
    // This is the key to avoiding duplicate configuration.
    freeDomains = plugin.config.get('host_list', 'list').map(d => d.toLowerCase());
    plugin.loginfo(`Loaded ${freeDomains.length} free domains to ignore: ${freeDomains.join(', ')}`);

    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    const mongoUrl = process.env.MONGO_URI || 'mongodb://localhost:27017';
    const dbName = 'freecustomemail';

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
            "customDomains.verified": true, // ✅ Only verified ones
            "plan": "pro"
        });

        if (userWithDomain) {
            // Find the exact domain record to get its TXT verification value and MX record
            const domainRecord = userWithDomain.customDomains.find(d => d.domain === domain && d.verified);
            const expectedTxtValue = domainRecord?.txtRecord;
            const expectedMxHost = domainRecord?.mxRecord || 'mx.freecustom.email';

            if (!expectedTxtValue) {
                plugin.logerror(`Verified domain ${domain} has no TXT record stored.`);
                return next(DENY, `Invalid domain verification setup for ${domain}`);
            }

            try {
                // --- TXT Record Validation ---
                const txtRecords = await dns.resolveTxt(domain);
                const isTxtVerified = txtRecords.flat().includes(expectedTxtValue);

                if (!isTxtVerified) {
                    // TXT record no longer matches — instantly set verified=false
                    await db.collection('users').updateOne(
                        { _id: userWithDomain._id, "customDomains.domain": domain },
                        { $set: { "customDomains.$.verified": false } }
                    );

                    // Remove from Redis cache if present
                    await redisClient.sRem(customDomainsSetKey, domain);

                    plugin.logerror(`TXT record mismatch for ${domain}. Verification revoked.`);
                    return next(DENY, `Domain ${domain} TXT record mismatch. Contact admin to re-verify.`);
                }

                // --- NEW: MX Record Validation ---
                let mxRecords = [];
                try {
                    mxRecords = await dns.resolveMx(domain);
                } catch (mxError) {
                    if (mxError.code === 'ENODATA' || mxError.code === 'ENOTFOUND') {
                        // MX record missing - revoke verification
                        await db.collection('users').updateOne(
                            { _id: userWithDomain._id, "customDomains.domain": domain },
                            { $set: { "customDomains.$.verified": false } }
                        );
                        await redisClient.sRem(customDomainsSetKey, domain);
                        
                        plugin.logerror(`MX record not found for ${domain}. Verification revoked.`);
                        return next(DENY, `Domain ${domain} has no MX record. Contact admin to re-verify.`);
                    }
                    throw mxError; // Re-throw other errors
                }

                const isMxValid = mxRecords.some(mx => 
                    mx.exchange.toLowerCase() === expectedMxHost.toLowerCase() ||
                    mx.exchange.toLowerCase().endsWith('.freecustom.email')
                );

                if (!isMxValid) {
                    // MX record doesn't point to our server - revoke verification
                    await db.collection('users').updateOne(
                        { _id: userWithDomain._id, "customDomains.domain": domain },
                        { $set: { "customDomains.$.verified": false } }
                    );
                    await redisClient.sRem(customDomainsSetKey, domain);

                    const currentMxHosts = mxRecords.map(m => m.exchange).join(', ');
                    plugin.logerror(`MX record mismatch for ${domain}. Expected ${expectedMxHost}, got: ${currentMxHosts}`);
                    return next(DENY, `Domain ${domain} MX record mismatch. Contact admin to re-verify.`);
                }

                // ✅ Passed both TXT and MX checks — cache and accept
                await redisClient.sAdd(customDomainsSetKey, domain);
                connection.logdebug(plugin, `Domain ${domain} passed both TXT and MX validation.`);
                return next(OK);

            } catch (err) {
                plugin.logerror(`DNS lookup failed for ${domain}: ${err.message}`);
                return next(DENYSOFT, `Could not verify DNS records for ${domain}. Try again later.`);
            }
        }

        // No verified entry → skip
        connection.logdebug(plugin, `Domain ${domain} not found as verified in MongoDB. Deferring.`);
        next();
    } catch (e) {
        plugin.logerror(`Error checking custom domain ${domain}: ${e.stack}`);
        next(DENYSOFT, 'Temporary backend error during address validation.');
    }
};