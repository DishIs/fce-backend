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

// ── OTP Extractor ─────────────────────────────────────────────────────────────
// Checks subject first (faster, more reliable), then falls back to plain text.
// Four layered patterns ordered by confidence.
function extractOtp(subject, text) {
    const sources = [subject, text].filter(Boolean);
    for (const src of sources) {
        // P1: keyword immediately before digits  ("Your code: 123456", "OTP is 456789")
        let m = src.match(/(?:code|otp|verification|verify|pin|token|passcode|one.time)[^0-9]{0,15}(\b\d{4,8}\b)/i);
        if (m) return m[1];

        // P2: digits before keyword  ("123456 is your OTP", "456789 — verification code")
        m = src.match(/\b(\d{4,8})\b[^0-9]{0,30}(?:code|otp|verification|verify|pin|token|passcode)/i);
        if (m) return m[1];

        // P3: standalone 6-digit number (most common OTP length)
        m = src.match(/\b(\d{6})\b/);
        if (m) return m[1];

        // P4: standalone 4 or 8-digit number (bank PINs, backup codes)
        m = src.match(/\b(\d{4}|\d{8})\b/);
        if (m) return m[1];
    }
    return null;
}

// ── Verification / Magic Link Extractor ──────────────────────────────────────
// Extracts the first URL whose href OR surrounding text matches verification keywords.
// Works on both HTML (href attributes) and plain text (raw URLs).
function extractVerificationLink(html, text) {
    const verifyPattern = /verif|confirm|activat|validat|magic.link|click.here|complete|authenticate|auth|reset.password|unsubscri/i;

    // 1. Parse href attributes from HTML — most reliable since the link text is nearby
    if (html) {
        const hrefRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
        let match;
        while ((match = hrefRegex.exec(html)) !== null) {
            const href = match[1];
            const linkText = match[2].replace(/<[^>]+>/g, '').trim(); // strip inner tags
            // Accept if URL itself or the link text looks like a verification link
            if (verifyPattern.test(href) || verifyPattern.test(linkText)) {
                // Filter out unsubscribe-only links unless nothing else found
                if (!/unsubscri/i.test(href) && !/unsubscri/i.test(linkText)) {
                    try { new URL(href); return href; } catch (_) { /* invalid URL, skip */ }
                }
            }
        }

        // Second pass: check the 100-char context window around each https link in HTML
        const allHrefs = [...html.matchAll(/href=["']([^"']+)["']/gi)].map(m => m[1]);
        for (const href of allHrefs) {
            const idx = html.indexOf(href);
            const ctx = html.slice(Math.max(0, idx - 100), idx + href.length + 100);
            if (verifyPattern.test(ctx.replace(/<[^>]+>/g, ''))) {
                try { new URL(href); return href; } catch (_) { /* skip */ }
            }
        }
    }

    // 2. Plain text fallback — look for URLs with verify-like path segments
    if (text) {
        const urlRegex = /https?:\/\/[^\s"'<>\]]+/g;
        const urls = text.match(urlRegex) || [];
        for (const url of urls) {
            if (verifyPattern.test(url)) {
                try { new URL(url); return url; } catch (_) { /* skip */ }
            }
        }

        // Final pass: check 200-char context window around each URL in plain text
        for (const url of urls) {
            const idx = text.indexOf(url);
            const ctx = text.slice(Math.max(0, idx - 200), idx + url.length + 200);
            if (verifyPattern.test(ctx)) {
                try { new URL(url); return url; } catch (_) { /* skip */ }
            }
        }
    }

    return null;
}

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

        const parts = recipientEmail.split('@');
        const recipientDomain = parts.length > 1 ? parts[1] : '';
        const ttl = parseInt(plugin.cfg.main.plan_cache_ttl, 10) || 3600;

        let user;
        let userData;

        user = await db.collection('users').findOne({
            plan: 'pro',
            'customDomains.domain': recipientDomain,
            'customDomains.verified': true
        });

        if (user) {
            userData = { plan: 'pro', userId: user._id, isVerified: true };
            await redisClient.set(cacheKey, JSON.stringify(userData), { EX: ttl });
            return userData;
        }

        user = await db.collection('users').findOne({ plan: 'pro', inboxes: recipientEmail });
        if (user) {
            userData = { plan: 'pro', userId: user._id, isVerified: false };
            await redisClient.set(cacheKey, JSON.stringify(userData), { EX: ttl });
            return userData;
        }

        user = await db.collection('users').findOne({ plan: 'free', inboxes: recipientEmail });
        if (user) {
            userData = { plan: 'free', userId: user._id, isVerified: false };
            await redisClient.set(cacheKey, JSON.stringify(userData), { EX: ttl });
            return userData;
        }

        userData = { plan: 'anonymous', userId: null, isVerified: false };
        await redisClient.set(cacheKey, JSON.stringify(userData), { EX: ttl });
        return userData;

    } catch (err) {
        plugin.logerror(`Error fetching user data for ${recipientEmail}: ${err}`);
        return { plan: 'anonymous', userId: null, isVerified: false };
    }
}

async function getUserStorageUsage(userId) {
    if (!db) return 0;
    try {
        const result = await db.collection('saved_emails').aggregate([
            { $match: { userId: new ObjectId(userId) } },
            { $unwind: { path: "$attachments", preserveNullAndEmptyArrays: true } },
            { $group: { _id: null, totalBytes: { $sum: { $ifNull: ["$attachments.size", 0] } } } }
        ]).toArray();
        return result[0]?.totalBytes || 0;
    } catch (err) {
        plugin.logerror(`Error calculating storage usage for user ${userId}: ${err}`);
        return 0;
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
                    use_gridfs: true,
                };
            } else if (plan === 'free') {
                cfg = {
                    mailbox_size: parseInt(plugin.cfg.main.free_mailbox_size, 10),
                    mailbox_ttl: parseInt(plugin.cfg.main.free_mailbox_ttl, 10),
                    attachment_limit: parseInt(plugin.cfg.main.free_attachment_limit_mb, 10) * 1024 * 1024,
                    save_to_mongo: false,
                    use_gridfs: true,
                };
            } else {
                cfg = {
                    mailbox_size: parseInt(plugin.cfg.main.anon_mailbox_size, 10),
                    mailbox_ttl: parseInt(plugin.cfg.main.anon_mailbox_ttl, 10),
                    attachment_limit: 0,
                    save_to_mongo: false,
                    use_gridfs: false,
                };
            }

            const MAX_STORAGE_BYTES = 5 * 1024 * 1024 * 1024;
            let currentStorageUsage = 0;

            if (plan === 'pro' && userId) {
                currentStorageUsage = await getUserStorageUsage(userId);
                if (currentStorageUsage >= MAX_STORAGE_BYTES) {
                    plugin.logwarn(`User ${userId} has reached 5GB storage limit. Stripping all attachments.`);
                    cfg.attachment_limit = 0;
                }
            }

            const attachmentsForRedis = [];
            const attachmentsForMongo = [];
            let attachmentsRemoved = false;
            let totalNewAttachmentSize = 0;

            for (const att of (parsed.attachments || [])) {
                if (att.size > cfg.attachment_limit) {
                    attachmentsRemoved = true;
                    continue;
                }

                if (plan === 'pro' && userId) {
                    if (currentStorageUsage + totalNewAttachmentSize + att.size > MAX_STORAGE_BYTES) {
                        plugin.logwarn(`Attachment "${att.filename}" would exceed 5GB limit. Stripping.`);
                        attachmentsRemoved = true;
                        continue;
                    }
                    totalNewAttachmentSize += att.size;
                }

                if (cfg.use_gridfs && userId) {
                    const uploadStream = gfs.openUploadStream(att.filename, {
                        contentType: att.contentType,
                        metadata: { userId, mailbox: destination, plan, uploadedAt: new Date() }
                    });

                    await new Promise((resolve, reject) => {
                        const readStream = Readable.from(att.content);
                        readStream.pipe(uploadStream)
                            .on('finish', resolve)
                            .on('error', reject);
                    });

                    attachmentsForRedis.push({
                        filename: att.filename,
                        contentType: att.contentType,
                        size: att.size,
                        gridfs_id: uploadStream.id.toString(),
                    });
                    attachmentsForMongo.push({
                        gridfs_id: uploadStream.id,
                        filename: att.filename,
                        contentType: att.contentType,
                        size: att.size
                    });
                } else {
                    attachmentsForRedis.push({
                        filename: att.filename,
                        contentType: att.contentType,
                        size: att.size,
                        content: att.content.toString('base64'),
                    });
                }
            }

            if (attachmentsRemoved) {
                const reason = (plan === 'pro' && currentStorageUsage >= MAX_STORAGE_BYTES)
                    ? "You have reached your 5GB storage limit. Please delete old emails to receive new attachments."
                    : "One or more attachments were removed due to size limits for your plan.";
                const notice = `<br><p><i>[${reason}]</i></p>`;
                parsed.html = parsed.html ? parsed.html + notice : parsed.textAsHtml + notice;
            }

            // ── Pro-only: extract OTP and verification link ───────────────────────
            let otp = null;
            let verificationLink = null;

            if (plan === 'pro') {
                otp = extractOtp(parsed.subject, parsed.text);
                verificationLink = extractVerificationLink(parsed.html || parsed.textAsHtml, parsed.text);

                if (otp) plugin.logdebug(`OTP extracted for ${destination}: ${otp}`);
                if (verificationLink) plugin.logdebug(`Verification link extracted for ${destination}`);
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
                wasAttachmentStripped: attachmentsRemoved,
                html: parsed.html || parsed.textAsHtml,
                text: parsed.text,
                attachments: attachmentsForRedis,
                // Pro-only fields — null for free/anonymous, omitted cleanly below
                ...(plan === 'pro' && { otp, verificationLink }),
            };

            if (cfg.save_to_mongo && userId) {
                const mongoRecord = {
                    userId,
                    mailbox: destination,
                    messageId,
                    from: parsed.from,
                    to: parsed.to?.value,
                    subject: parsed.subject,
                    date: messageDate,
                    html: parsed.html,
                    text: parsed.text,
                    attachments: attachmentsForMongo,
                    headers: parsed.headers,
                    storageUsed: totalNewAttachmentSize,
                    // Store for MongoDB fallback path
                    ...(plan === 'pro' && { otp, verificationLink }),
                };
                db.collection('saved_emails').insertOne(mongoRecord).catch(err => {
                    plugin.logerror(`MongoDB insertOne failed for ${destination}: ${err}`);
                });
            }

            const indexKey = `maildrop:${plan}:${destination}:index`;
            const dataKey = `maildrop:${plan}:${destination}:data`;

            const currentSize = await redisClient.zCard(indexKey);
            const multi = redisClient.multi();

            if (currentSize >= cfg.mailbox_size) {
                const numToRemove = (currentSize - cfg.mailbox_size) + 1;
                const oldIds = await redisClient.zRange(indexKey, 0, numToRemove - 1);
                if (oldIds && oldIds.length > 0) {
                    if (cfg.use_gridfs && userId) {
                        for (const oldId of oldIds) {
                            const oldMsg = await redisClient.hGet(dataKey, oldId);
                            if (oldMsg) {
                                try {
                                    const msg = JSON.parse(oldMsg);
                                    if (msg.attachments && msg.attachments.length > 0) {
                                        for (const att of msg.attachments) {
                                            if (att.gridfs_id) {
                                                await gfs.delete(new ObjectId(att.gridfs_id));
                                            }
                                        }
                                    }
                                } catch (err) {
                                    plugin.logerror(`Error cleaning up GridFS files for message ${oldId}: ${err}`);
                                }
                            }
                        }
                    }
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

            // ── Publish WebSocket event — includes otp + verificationLink for pro ──
            multi.publish(`mailbox:events:${destination}`, JSON.stringify({
                type: 'new_mail',
                mailbox: destination,
                plan,
                id: fullMessage.id,
                from: fullMessage.from,
                to: fullMessage.to,
                subject: fullMessage.subject,
                date: fullMessage.date,
                hasAttachment: fullMessage.hasAttachment,
                // Pro fields included in real-time event so client needs no API call
                ...(plan === 'pro' && { otp, verificationLink }),
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