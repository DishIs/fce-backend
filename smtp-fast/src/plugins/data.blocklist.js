// /home/dit/maildrop/smtp-fast/src/plugins/data.blocklist.js
const redis = require('redis');
const { MongoClient } = require('mongodb');

// These clients are defined in the outer scope to be shared across connections.
let redisClient;
let mongoClient;
let db;

/**
 * The register function is the entry point for the plugin.
 */
exports.register = function () {
    this.loginfo("Initializing data.blocklist plugin");
    this.load_ini();
    this.register_hook('data', 'check_blocklist');
};

/**
 * Loads the configuration and establishes connections to Redis and MongoDB.
 * This function is now async to ensure connections are ready before proceeding.
 */
exports.load_ini = async function () {
    const plugin = this;

    plugin.cfg = plugin.config.get('redis.ini', 'ini');

    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    const mongoUrl = process.env.MONGO_URI || 'mongodb://localhost:27017/freecustomemail';
    const dbName = 'freecustomemail';

    // --- Redis Connection ---
    if (!redisClient) {
        plugin.logdebug(`Connecting to Redis at ${redisUrl}`);
        redisClient = redis.createClient({ url: redisUrl });
        redisClient.on('error', (err) => plugin.logerror(`Redis client error: ${err}`));
        redisClient.on('ready', () => plugin.loginfo('Redis client is ready.'));
        // We don't await here, the client will connect in the background.
        // The check_blocklist hook will check `isOpen`.
        redisClient.connect().catch(err => plugin.logerror(`Redis initial connect failed: ${err}`));
    }

    // --- MongoDB Connection (now robust with async/await) ---
    if (!mongoClient) {
        plugin.logdebug(`Connecting to MongoDB at ${mongoUrl}`);
        try {
            mongoClient = new MongoClient(mongoUrl);
            await mongoClient.connect();
            plugin.loginfo('MongoDB client connected successfully.');
            db = mongoClient.db(dbName);
        } catch (err) {
            plugin.logerror(`FATAL: MongoDB connection failed on startup. Fallback check will not work. Error: ${err}`);
            // We do not re-throw, to allow Haraka to start. The hook will handle db being null.
        }
    }
};

/**
 * This function is called when Haraka is shutting down.
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
 * The core logic of the plugin, with added MongoDB fallback.
 */
exports.check_blocklist = async function (next, connection) {
    const plugin = this;
    const transaction = connection.transaction;

    const sender = transaction.mail_from.address().toLowerCase();
    const recipients = transaction.rcpt_to;

    for (const recipient of recipients) {
        const recipientAddress = `${recipient.user}@${recipient.host}`.toLowerCase();
        
        // --- Find the owner of the inbox via Redis map ---
        let inboxOwnerId;
        if (redisClient?.isOpen) {
            try {
                inboxOwnerId = await redisClient.get(`inboxmap:${recipientAddress}`);
            } catch (e) {
                plugin.logerror(`Redis error getting inbox owner for ${recipientAddress}: ${e}`);
                continue; // Skip to next recipient on error
            }
        } else {
            plugin.logerror("Redis is not connected. Skipping all blocklist checks.");
            return next(); // Allow all mail if Redis is down
        }

        if (!inboxOwnerId) {
            continue; // Not a managed inbox, skip.
        }

        const userMuteListKey = `mutelist:${inboxOwnerId}`;

        // --- STAGE 1: Check Redis First (Fastest) ---
        try {
            const isMutedInRedis = await redisClient.sIsMember(userMuteListKey, sender);

            if (isMutedInRedis) {
                plugin.logwarn(`DENYING (Redis) email from ${sender} to ${recipientAddress} as per mute list.`);
                return next(DENY, `The recipient has blocked your email address.`);
            }
        } catch (e) {
            plugin.logerror(`Redis error checking mute list for ${userMuteListKey}: ${e}`);
            // Don't block email on Redis error, proceed to Mongo check or allow.
        }
        
        // --- STAGE 2: Fallback to MongoDB (Slower, but authoritative) ---
        plugin.logdebug(`Sender ${sender} not in Redis mute list for ${recipientAddress}. Checking MongoDB.`);

        // Check if the MongoDB connection from load_ini was successful.
        if (!db) {
            plugin.logerror("MongoDB is not connected. Cannot perform fallback blocklist check.");
            continue; // Skip to the next recipient.
        }
        
        try {
            // This query is highly efficient. It finds the user and checks if the sender
            // exists in the 'mutedSenders' array in a single operation.
            const isMutedInMongo = await db.collection('users').findOne({
                wyiUserId: inboxOwnerId,
                mutedSenders: sender
            });
            
            // If the query returns a document, it means a match was found.
            if (isMutedInMongo) {
                plugin.logwarn(`DENYING (MongoDB) email from ${sender} to ${recipientAddress} as per mute list.`);
                
                // OPTIONAL: As a self-healing mechanism, you could add the sender back to the Redis cache here.
                // redisClient.sAdd(userMuteListKey, sender).catch(err => plugin.logerror(`Failed to re-cache mute for ${sender}: ${err}`));
                
                return next(DENY, `The recipient has blocked your email address.`);
            }

        } catch (e) {
            plugin.logerror(`MongoDB error checking mute list for user ${inboxOwnerId}: ${e}`);
            // On DB error, fail-open (allow the email).
        }
    }

    // If we've looped through all recipients and found no reason to block, permit the email.
    next();
};