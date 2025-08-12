'use strict';

const shortid = require('shortid');
const { format } = require('date-fns');
const { simpleParser } = require('mailparser');
const { createClient } = require('redis');
const { MongoClient, GridFSBucket, ObjectId } = require('mongodb');
const { Readable } = require('stream');

let redisClient;
let mongoClient;
let db;
let gfs;
let plugin;

exports.register = function () {
    plugin = this;
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
                gfs = new GridFSBucket(db, { bucketName: 'attachments' });
                plugin.loginfo('Successfully connected to MongoDB and GridFS.');
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

async function getUserData(recipientUser) {
    if (!db || !redisClient.isOpen) return { plan: 'anonymous', userId: null };
    try {
        const userDataCacheKey = `user_data_cache:${recipientUser}`;
        const cachedUserData = await redisClient.get(userDataCacheKey);
        if (cachedUserData) {
            const data = JSON.parse(cachedUserData);
            data.userId = data.userId ? new ObjectId(data.userId) : null;
            return data;
        }
        const user = await db.collection('users').findOne({ inboxes: recipientUser });
        const userData = {
            plan: user ? user.plan : 'anonymous',
            userId: user ? user._id : null,
        };
        const ttl = parseInt(plugin.cfg.main.plan_cache_ttl, 10) || 3600;
        await redisClient.set(userDataCacheKey, JSON.stringify(userData), { EX: ttl });
        return userData;
    } catch (err) {
        plugin.logerror(`Error fetching user data for ${recipientUser}: ${err}`);
        return { plan: 'anonymous', userId: null };
    }
}

exports.tiered_save = async function (next, connection) {
    if (!db || !gfs || !redisClient.isOpen) {
        plugin.logerror("A database connection is not available.");
        return next(DENYSOFT, "Backend service is temporarily unavailable.");
    }

    const stream = connection.transaction.message_stream;

    try {
        const parsed = await simpleParser(stream);

        for (const recipient of connection.transaction.rcpt_to) {
            const destination = `${recipient.user}@${recipient.host}`.toLowerCase();
            const { plan, userId } = await getUserData(destination);

            plugin.logdebug(`Processing email for ${destination} with plan: ${plan}`);

            let cfg;
            if (plan === 'pro') {
                cfg = {
                    mailbox_size: parseInt(plugin.cfg.main.pro_mailbox_size, 10),
                    mailbox_ttl: null,
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
            } else {
                cfg = {
                    mailbox_size: parseInt(plugin.cfg.main.anon_mailbox_size, 10),
                    mailbox_ttl: parseInt(plugin.cfg.main.anon_mailbox_ttl, 10),
                    attachment_limit: 0,
                    save_to_mongo: false,
                };
            }

            const attachmentsForRedis = [];
            const attachmentsForMongo = [];
            let attachmentsRemoved = false;

            for (const att of (parsed.attachments || [])) {
                if (att.size > cfg.attachment_limit) {
                    attachmentsRemoved = true;
                    continue;
                }
                if (plan === 'pro' && userId) {
                    const uploadStream = gfs.openUploadStream(att.filename, {
                        contentType: att.contentType,
                        metadata: { userId, mailbox: destination }
                    });
                    Readable.from(att.content).pipe(uploadStream);

                    attachmentsForRedis.push({
                        filename: att.filename, contentType: att.contentType, size: att.size,
                        gridfs_id: uploadStream.id.toString(), // Store GridFS ID as string
                    });
                    attachmentsForMongo.push({ // This is for the permanent backup
                        gridfs_id: uploadStream.id,
                        filename: att.filename, contentType: att.contentType, size: att.size
                    });
                } else {
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

            const messageId = shortid.generate();
            const messageDate = new Date();
            const messageTimestamp = messageDate.getTime();

            const fullMessage = {
                id: messageId,
                from: parsed.from?.text || 'unknown',
                to: destination,
                subject: parsed.subject || '(no subject)',
                date: format(messageDate, "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'"),
                hasAttachment: attachmentsForRedis.length > 0,
                html: parsed.html || parsed.textAsHtml,
                text: parsed.text,
                attachments: attachmentsForRedis,
            };

            if (cfg.save_to_mongo && userId) {
                const mongoRecord = {
                    userId, mailbox: destination, messageId: messageId,
                    from: parsed.from, to: parsed.to?.value, subject: parsed.subject,
                    date: messageDate, html: parsed.html, text: parsed.text,
                    attachments: attachmentsForMongo, headers: parsed.headers,
                };
                db.collection('saved_emails').insertOne(mongoRecord).catch(err => {
                    plugin.logerror(`MongoDB insertOne failed for ${destination}: ${err}`);
                });
            }

            // --- REFACTORED: Efficiently Trim and Save ---
            const indexKey = `mailbox:${destination}:index`; // Sorted Set of message IDs
            const dataKey = `mailbox:${destination}:data`;   // Hash of message bodies

            const currentSize = await redisClient.zCard(indexKey);
            const multi = redisClient.multi();

            if (currentSize >= cfg.mailbox_size) {
                // Find the oldest message IDs to remove
                const numToRemove = (currentSize - cfg.mailbox_size) + 1;
                const oldIds = await redisClient.zRange(indexKey, 0, numToRemove - 1);
                if (oldIds && oldIds.length > 0) {
                    plugin.logdebug(`Trimming ${oldIds.length} old messages from ${destination}`);
                    multi.zRem(indexKey, oldIds); // Remove from sorted set
                    multi.hDel(dataKey, oldIds);  // Remove from hash
                }
            }
            
            // Add the new message
            multi.zAdd(indexKey, { score: messageTimestamp, value: messageId });
            multi.hSet(dataKey, messageId, JSON.stringify(fullMessage));

            // Set TTL on the keys for non-pro users
            if (cfg.mailbox_ttl) {
                multi.expire(indexKey, cfg.mailbox_ttl);
                multi.expire(dataKey, cfg.mailbox_ttl);
            }

            // Publish event for real-time updates
            multi.publish(`mailbox:events:${destination}`, JSON.stringify({
                type: 'new_mail',
                mailbox: destination,
                id: fullMessage.id, from: fullMessage.from, to: fullMessage.to,
                subject: fullMessage.subject, date: fullMessage.date,
                hasAttachment: fullMessage.hasAttachment
            }));

            await multi.exec();
            plugin.loginfo(`Successfully queued message ${messageId} for ${destination} using new model`);
        }
        next(OK);
    } catch (err) {
        plugin.logerror(`Critical error in tiered_save: ${err.stack}`);
        next(DENYSOFT, "Error processing message.");
    }
};