// This Haraka plugin checks incoming emails at the DATA stage.
// It uses Redis to perform a very fast check to see if the recipient
// has muted (or blocked) the sender's email address.

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
// In your /smtp-fast/src/plugins/rcpt_to_mongo.js file

exports.load_ini = function () {
    plugin.cfg = plugin.config.get('redis.ini', 'ini');
    
    // --- Load the list of free domains directly from the other plugin's config ---
    freeDomains = plugin.config.get('host_list', 'list').map(d => d.toLowerCase());
    plugin.loginfo(`Loaded ${freeDomains.length} free domains to ignore: ${freeDomains.join(', ')}`);

    // ========================================================================
    // --- START AGGRESSIVE DEBUGGING ---
    plugin.logcrit('--- DEBUGGING rcpt_to_mongo ---');
    try {
        plugin.logcrit(`plugin.cfg content from redis.ini: ${JSON.stringify(plugin.cfg, null, 2)}`);
        
        // Use optional chaining to prevent a crash if sections are missing
        const redisHost = plugin.cfg?.server?.host;
        const redisPort = plugin.cfg?.server?.port;
        
        plugin.logcrit(`Extracted redisHost: ${redisHost} (type: ${typeof redisHost})`);
        plugin.logcrit(`Extracted redisPort: ${redisPort} (type: ${typeof redisPort})`);
        
        const redisUrl = `redis://${redisHost}:${redisPort}`;
        plugin.logcrit(`CONSTRUCTED REDIS URL: ${redisUrl}`);
        // --- END AGGRESSIVE DEBUGGING ---
        // ========================================================================

        const mongoUrl = process.env.MONGO_URI || 'mongodb://localhost:27017/freecustomemail';
        const dbName = 'freecustomemail';
        
        if (!redisClient) {
            // This is the line that is crashing
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
                    plugin.logcrit(`FATAL: Could not connect to MongoDB. Error: ${err}`);
                });
        }
    } catch (e) {
        plugin.logcrit(`An error occurred during load_ini: ${e.stack}`);
        throw e; // Re-throw the error to ensure the process stops
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