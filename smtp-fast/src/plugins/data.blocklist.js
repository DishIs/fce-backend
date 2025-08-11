// This Haraka plugin checks incoming emails at the DATA stage.
// It uses Redis to perform a very fast check to see if the recipient
// has muted (or blocked) the sender's email address.
// /home/dit/maildrop/smtp-fast/src/plugins/data.blocklist.js
const redis = require('redis');
const { MongoClient } = require('mongodb');

// These clients are defined in the outer scope to be shared across connections.
let redisClient;
let mongoClient;
let db;

/**
 * The register function is the entry point for the plugin.
 * It's called once when Haraka starts.
 */
exports.register = function () {
    this.loginfo("Initializing data.blocklist plugin");

    // Loads configuration from data.blocklist.ini
    this.load_ini();

    // Register the function to run at the 'data' hook.
    // This hook runs after the DATA command is received, but before the email body is accepted.
    this.register_hook('data', 'check_blocklist');
};

/**
 * Loads the configuration from the .ini file and establishes
 * connections to Redis and MongoDB.
 */
exports.load_ini = function () {
    const plugin = this;

    // The config loader automatically looks for 'data.blocklist.ini'
    plugin.cfg = plugin.config.get('redis.ini', 'ini');

    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

    // Also, you'll need a way to get the mongo URL. The cleanest way is an environment variable.
    const mongoUrl = process.env.MONGO_URI || 'mongodb://localhost:27017/freecustomemail';

    const dbName = 'freecustomemail'; // You can hardcode this or get it from another config/env var

    // --- Redis Connection ---
    // Only create a new client if one doesn't already exist.
    if (!redisClient) {
        plugin.logdebug(`Connecting to Redis at ${redisUrl}`);
        redisClient = redis.createClient({ url: redisUrl });

        redisClient.on('error', (err) => {
            plugin.logerror(`Redis client error: ${err}`);
        });
        redisClient.on('connect', () => {
            plugin.logdebug('Redis client is connecting...');
        });
        redisClient.on('ready', () => {
            plugin.loginfo('Redis client is ready.');
        });

        // The 'await' here ensures that we don't proceed until the connection is attempted.
        // Haraka's async startup handles this correctly.
        redisClient.connect();
    }

    // --- MongoDB Connection ---
    // Although not used in the `check_blocklist` hook, we initialize it
    // here as per the plugin structure for potential future use.
    if (!mongoClient) {
        plugin.logdebug(`Connecting to MongoDB at ${mongoUrl}`);
        mongoClient = new MongoClient(mongoUrl);

        mongoClient.connect().then(() => {
            plugin.loginfo('MongoDB client connected successfully.');
            db = mongoClient.db(dbName);
        }).catch(err => {
            plugin.logerror(`MongoDB connection failed: ${err}`);
        });
    }
};

/**
 * This function is called when Haraka is shutting down.
 * It's crucial to close database connections gracefully.
 */
exports.shutdown = async function () {
    this.loginfo("Shutting down data.blocklist plugin");
    if (redisClient?.isOpen) {
        await redisClient.quit();
    }
    if (mongoClient) {
        await mongoClient.close();
    }
};

/**
 * The core logic of the plugin, executed for each email transaction.
 */
exports.check_blocklist = async function (next, connection) {
    const plugin = this;
    const transaction = connection.transaction;

    // Ensure Redis is connected and ready before proceeding.
    if (!redisClient?.isOpen) {
        plugin.logerror("Redis is not connected. Skipping blocklist check.");
        return next(); // Allow email to proceed
    }

    const sender = transaction.mail_from.address().toLowerCase();
    const recipients = transaction.rcpt_to;

    // An email can have multiple recipients. We must check each one.
    for (const recipient of recipients) {
        const recipientAddress = `${recipient.user}@${recipient.host}`.toLowerCase();

        // --- CRITICAL STEP: Find the owner of the inbox ---
        // This plugin assumes that your API maintains a Redis key that maps an
        // inbox address to the unique ID of the user who owns it.
        // For example: Key = "inboxmap:user@custom.com", Value = "the_users_wyiUserId"
        const inboxOwnerId = await redisClient.get(`inboxmap:${recipientAddress}`);

        // If this key doesn't exist, it's not an inbox managed by a logged-in user.
        // We can safely skip it.
        if (!inboxOwnerId) {
            continue;
        }

        // The key for the user's personal mute list Set in Redis.
        // This is consistent with what the API writes to.
        const userMuteListKey = `mutelist:${inboxOwnerId}`;

        try {
            // sIsMember is an O(1) operation, making this check extremely fast.
            const isMuted = await redisClient.sIsMember(userMuteListKey, sender);

            if (isMuted) {
                plugin.logwarn(`DENYING email from ${sender} to ${recipientAddress} (owner: ${inboxOwnerId}) as per user's mute list.`);
                // DENY tells Haraka to reject this email with a 5xx error code.
                return next(DENY, `The recipient has blocked your email address.`);
            }
        } catch (e) {
            // If there's a Redis error during the check, log it but allow the email.
            // It's better to let a spam email through than to block a legitimate one.
            plugin.logerror(`Redis error checking mute list for ${userMuteListKey}: ${e}`);
        }
    }

    // If the loop completes without any blocks, allow the email to proceed.
    next();
};