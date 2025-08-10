'use strict';

const shortid = require('shortid');
const { format } = require('date-fns');
const { simpleParser } = require('mailparser');
const { createClient } = require('redis');
const { MongoClient, GridFSBucket, ObjectId } = require('mongodb');
const { Readable } = require('stream');

// --- Module-level variables for persistent connections ---
let redisClient;
let mongoClient;
let db;
let gfs;
let plugin; // To access cfg from helpers

exports.register = function () {
    plugin = this; // Make plugin instance available throughout
    plugin.load_ini();
    plugin.register_hook('queue', 'tiered_save');
};

exports.load_ini = function () {
    plugin.cfg = plugin.config.get('queue.redis.ini', () => {
        plugin.load_ini();
    });

    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    const mongoUrl = process.env.MONGO_URI || 'mongodb://localhost:27017';
    const dbName = 'freecustomemail';

    // --- Initialize Redis Connection ---
    if (!redisClient) {
        redisClient = createClient({ url: redisUrl });
        redisClient.on('error', (err) => plugin.logerror(`Redis Client Error: ${err}`));
        redisClient.connect().catch(err => plugin.logerror(`Redis connect failed: ${err}`));
    }

    // --- Initialize MongoDB Connection ---
    if (!mongoClient) {
        mongoClient = new MongoClient(mongoUrl);
        mongoClient.connect()
            .then(() => {
                db = mongoClient.db(dbName);
                gfs = new GridFSBucket(db, { bucketName: 'attachments' });
                plugin.loginfo('Successfully connected to MongoDB and GridFS.');
            })
            .catch(err => {
                plugin.logcrit(`FATAL: Could not connect to MongoDB. Plugin will not work. Error: ${err}`);
            });
    }
};

/**
 * Shuts down database connections gracefully.
 * Haraka calls this on shutdown.
 */
exports.shutdown = function () {
    if (redisClient) redisClient.quit();
    if (mongoClient) mongoClient.close();
};

/**
 * Fetches user data (plan and ID) based on an inbox name.
 * Uses a two-step Redis cache to minimize DB queries.
 * @param {string} recipientUser - The user part of the email address (e.g., 'myinbox').
 * @returns {Promise<object>} - { plan: 'pro'|'free'|'anonymous', userId: ObjectId|null }
 */
async function getUserData(recipientUser) {
    if (!db || !redisClient.isOpen) return { plan: 'anonymous', userId: null };

    try {
        // Step 1: Check cache for the final user data object.
        const userDataCacheKey = `user_data_cache:${recipientUser}`;
        const cachedUserData = await redisClient.get(userDataCacheKey);
        if (cachedUserData) {
            const data = JSON.parse(cachedUserData);
            // MongoDB's ObjectId needs to be reconstituted
            data.userId = data.userId ? new ObjectId(data.userId) : null;
            return data;
        }

        // Step 2: If no direct cache, find the user in MongoDB.
        // This assumes your API/frontend creates a 'users' collection with an 'inboxes' array field.
        const user = await db.collection('users').findOne({ inboxes: recipientUser });

        const userData = {
            plan: user ? user.plan : 'anonymous',
            userId: user ? user._id : null,
        };

        // Step 3: Cache the retrieved data for future requests.
        const ttl = parseInt(plugin.cfg.main.plan_cache_ttl, 10) || 3600;
        await redisClient.set(userDataCacheKey, JSON.stringify(userData), { EX: ttl });

        return userData;

    } catch (err) {
        plugin.logerror(`Error fetching user data for ${recipientUser}: ${err}`);
        return { plan: 'anonymous', userId: null };
    }
}

exports.tiered_save = async function (next, connection) {
    // Ensure connections are ready before processing.
    if (!db || !gfs || !redisClient.isOpen) {
        plugin.logerror("A database connection is not available.");
        return next(DENYSOFT, "Backend service is temporarily unavailable.");
    }

    const stream = connection.transaction.message_stream;

    try {
        const parsed = await simpleParser(stream);

        for (const recipient of connection.transaction.rcpt_to) {
            const destination = recipient.user.toLowerCase();
            const { plan, userId } = await getUserData(destination);

            plugin.logdebug(`Processing email for ${destination} with plan: ${plan}`);

            // --- 1. Define Tier-Specific Configuration ---
            let cfg;
            if (plan === 'pro') {
                cfg = {
                    mailbox_size: parseInt(plugin.cfg.main.pro_mailbox_size, 10),
                    mailbox_ttl: null, // No expiry for Redis records
                    attachment_limit: parseInt(plugin.cfg.main.pro_attachment_limit_mb, 10) * 1024 * 1024,
                    save_to_mongo: true,
                };
            } else if (plan === 'free') {
                cfg = {
                    mailbox_size: parseInt(plugin.cfg.main.free_mailbox_size, 10),
                    mailbox_ttl: parseInt(plugin.cfg.main.free_mailbox_ttl, 10),
                    attachment_limit: parseInt(plugin.cfg.main.free_attachment_limit_mb, 10) * 1024 * 1024,
                    save_to_mongo: false,
                };
            } else { // Anonymous
                cfg = {
                    mailbox_size: parseInt(plugin.cfg.main.anon_mailbox_size, 10),
                    mailbox_ttl: parseInt(plugin.cfg.main.anon_mailbox_ttl, 10),
                    attachment_limit: 0,
                    save_to_mongo: false,
                };
            }

            // --- 2. Process Attachments Based on Plan ---
            const attachmentsForRedis = [];
            const attachmentsForMongo = [];
            let attachmentsRemoved = false;

            for (const att of (parsed.attachments || [])) {
                if (att.size > cfg.attachment_limit) {
                    attachmentsRemoved = true;
                    continue; // Skip attachment, too large for this plan
                }
                
                if (plan === 'pro') {
                    // For Pro, stream to GridFS and store references
                    const uploadStream = gfs.openUploadStream(att.filename, {
                        contentType: att.contentType,
                        metadata: { userId, mailbox: destination }
                    });
                    Readable.from(att.content).pipe(uploadStream);

                    attachmentsForRedis.push({
                        filename: att.filename, contentType: att.contentType, size: att.size,
                        gridfs: true // A flag for the API to know where to find the content
                    });
                    attachmentsForMongo.push({
                        gridfs_id: uploadStream.id,
                        filename: att.filename, contentType: att.contentType, size: att.size
                    });

                } else {
                    // For Free/Anon, store base64 content directly in Redis
                    attachmentsForRedis.push({
                        filename: att.filename, contentType: att.contentType, size: att.size,
                        content: att.content.toString('base64'),
                    });
                }
            }

            if (attachmentsRemoved) {
                const notice = "<br><p><i>[One or more attachments were removed. Your plan may have a size limit, or you may need to log in.]</i></p>";
                parsed.html = parsed.html ? parsed.html + notice : parsed.textAsHtml + notice;
            }
            
            // --- 3. Construct Message Objects ---
            const messageId = shortid.generate();
            const messageDate = new Date();

            const redisSummary = {
                id: messageId,
                from: parsed.from?.text || 'unknown',
                to: destination,
                subject: parsed.subject || '(no subject)',
                date: format(messageDate, "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'"),
                hasAttachment: attachmentsForRedis.length > 0
            };

            const redisBody = {
                ...redisSummary,
                html: parsed.html || parsed.textAsHtml,
                text: parsed.text,
                attachments: attachmentsForRedis,
            };

            // --- 4. Persist to MongoDB for Pro Users ---
            if (cfg.save_to_mongo) {
                const mongoRecord = {
                    userId,
                    mailbox: destination,
                    messageId: messageId,
                    from: parsed.from,
                    to: parsed.to?.value,
                    subject: parsed.subject,
                    date: messageDate,
                    html: parsed.html,
                    text: parsed.text,
                    attachments: attachmentsForMongo,
                    headers: parsed.headers,
                };
                db.collection('saved_emails').insertOne(mongoRecord).catch(err => {
                    plugin.logerror(`MongoDB insertOne failed for ${destination}: ${err}`);
                });
            }

            // --- 5. Execute Atomic Redis Transaction ---
            const key = `mailbox:${destination}`;
            const multi = redisClient.multi()
                .lPush(key, JSON.stringify(redisSummary))
                .lPush(`${key}:body`, JSON.stringify(redisBody))
                .lTrim(key, 0, cfg.mailbox_size - 1)
                .lTrim(`${key}:body`, 0, cfg.mailbox_size - 1)
                .publish(`mailbox:events:${destination}`, JSON.stringify({
                    type: 'new_mail',
                    mailbox: destination,
                    ...redisSummary,
                }));
            
            if (cfg.mailbox_ttl) {
                multi.expire(key, cfg.mailbox_ttl);
                multi.expire(`${key}:body`, cfg.mailbox_ttl);
            }
            
            await multi.exec();
            plugin.loginfo(`Successfully queued message ${messageId} for ${destination}`);
        }

        next(OK);

    } catch (err) {
        plugin.logerror(`Critical error in tiered_save: ${err.stack}`);
        next(DENYSOFT, "Error processing message.");
    }
};