'use strict';

const shortid = require('shortid');
const { format } = require('date-fns');
const { simpleParser } = require('mailparser');
const { createClient } = require('redis');
const { MongoClient, GridFSBucket, ObjectId } = require('mongodb');
const { Readable } = require('stream');
const jwt = require('jsonwebtoken'); // Assuming JWT library is available

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

async function getUserData(recipientEmail) {
    if (!db || !redisClient.isOpen) return { plan: 'anonymous', userId: null, isVerified: false };
    try {
        const cacheKey = `user_data_cache:${recipientEmail}`;
        const cachedData = await redisClient.get(cacheKey);
        if (cachedData) {
            const data = JSON.parse(cachedData);
            data.userId = data.userId ? new ObjectId(data.userId) : null;
            return data;
        }

        const recipientDomain = recipientEmail.split('@')[1];
        const ttl = parseInt(plugin.cfg.main.plan_cache_ttl, 10) || 3600;
        let user;
        let userData;

        // 1. Prioritize pro users with a verified custom domain.
        // This query finds a user where the `customDomains` array contains an element
        // that matches both the domain and the verified status.
        user = await db.collection('users').findOne({
            plan: 'pro',
            'customDomains.domain': recipientDomain,
            'customDomains.verified': true
        });

        if (user) {
            userData = { plan: 'pro', userId: user._id, isVerified: true };
            await redisClient.set(cacheKey, JSON.stringify(userData), { EX: ttl });
            userData.userId = new ObjectId(userData.userId);
            return userData;
        }

        // 2. Find a Pro user with this specific inbox address.
        user = await db.collection('users').findOne({ plan: 'pro', inboxes: recipientEmail });
        if (user) {
            userData = { plan: 'pro', userId: user._id, isVerified: false };
            await redisClient.set(cacheKey, JSON.stringify(userData), { EX: ttl });
            userData.userId = new ObjectId(userData.userId);
            return userData;
        }

        // 3. Find a Free user with this specific inbox address.
        user = await db.collection('users').findOne({ plan: 'free', inboxes: recipientEmail });
        if (user) {
            userData = { plan: 'free', userId: user._id, isVerified: false };
            await redisClient.set(cacheKey, JSON.stringify(userData), { EX: ttl });
            userData.userId = new ObjectId(userData.userId);
            return userData;
        }

        // 4. Default to anonymous if no user is found.
        userData = { plan: 'anonymous', userId: null, isVerified: false };
        // Cache the anonymous result to prevent repeated DB lookups for non-existent users.
        await redisClient.set(cacheKey, JSON.stringify(userData), { EX: ttl });
        return userData;

    } catch (err) {
        plugin.logerror(`Error fetching user data for ${recipientEmail}: ${err}`);
        return { plan: 'anonymous', userId: null, isVerified: false };
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
            const { plan, userId, isVerified } = await getUserData(destination);

            plugin.logdebug(`Processing email for ${destination} with plan: ${plan} (Verified: ${isVerified})`);

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
            } else { // anonymous
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
                        gridfs_id: uploadStream.id.toString(),
                    });
                    attachmentsForMongo.push({
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
                const notice = "<br><p><i>[One or more attachments were removed due to size limits for your plan.]</i></p>";
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
            
            // --- NEW: Plan-based Redis keys ---
            const indexKey = `maildrop:${plan}:${destination}:index`;
            const dataKey = `maildrop:${plan}:${destination}:data`;

            const currentSize = await redisClient.zCard(indexKey);
            const multi = redisClient.multi();

            if (currentSize >= cfg.mailbox_size) {
                const numToRemove = (currentSize - cfg.mailbox_size) + 1;
                const oldIds = await redisClient.zRange(indexKey, 0, numToRemove - 1);
                if (oldIds && oldIds.length > 0) {
                    plugin.logdebug(`Trimming ${oldIds.length} old messages from ${destination} (${plan})`);
                    multi.zRem(indexKey, oldIds);
                    multi.hDel(dataKey, oldIds);
                }
            }
            
            multi.zAdd(indexKey, { score: messageTimestamp, value: messageId });
            multi.hSet(dataKey, messageId, JSON.stringify(fullMessage));

            if (cfg.mailbox_ttl) {
                multi.expire(indexKey, cfg.mailbox_ttl);
                multi.expire(dataKey, cfg.mailbox_ttl);
            }

            multi.publish(`mailbox:events:${destination}`, JSON.stringify({
                type: 'new_mail',
                mailbox: destination,
                plan: plan, // Announce the plan for potential client-side logic
                id: fullMessage.id, from: fullMessage.from, to: fullMessage.to,
                subject: fullMessage.subject, date: fullMessage.date,
                hasAttachment: fullMessage.hasAttachment
            }));

            await multi.exec();
            plugin.loginfo(`Successfully queued message ${messageId} for ${destination} to plan '${plan}'`);
        }
        next(OK);
    } catch (err) {
        plugin.logerror(`Critical error in tiered_save: ${err.stack}`);
        next(DENYSOFT, "Error processing message.");
    }
};