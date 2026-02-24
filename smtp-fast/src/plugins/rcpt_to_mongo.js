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

// rcpt_to_mongo.js — RCPT hook only does Redis lookup.
// Redis is populated by a separate verification worker.

exports.check_custom_domain = async function (next, connection, params) {
    const domain = params[0].host.toLowerCase();

    if (freeDomains.includes(domain)) return next();

    if (!redisClient.isOpen) {
        plugin.logerror("Redis not available for custom domain check.");
        return next(DENYSOFT, "Backend temporarily unavailable.");
    }

    try {
        const isMember = await redisClient.sIsMember('verified_custom_domains', domain);
        if (isMember) return next(OK);

        // Not in Redis — do a single fast MongoDB lookup, NO DNS here.
        // DNS was already verified when the user set up their domain in the dashboard,
        // and is periodically re-verified by the background worker.
        const user = await db.collection('users').findOne({
            plan: 'pro',
            'customDomains.domain': domain,
            'customDomains.verified': true
        });

        if (user) {
            // Warm the cache so next email is instant
            await redisClient.sAdd('verified_custom_domains', domain);
            return next(OK);
        }

        next(); // unknown domain, let it fall through
    } catch (e) {
        plugin.logerror(`Error in check_custom_domain for ${domain}: ${e.stack}`);
        next(DENYSOFT, 'Temporary backend error.');
    }
};