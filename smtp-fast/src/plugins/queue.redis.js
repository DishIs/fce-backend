'use strict';

const shortid = require('shortid');
const { format } = require('date-fns');
const { simpleParser } = require('mailparser');
const { createClient } = require('redis');
const { MongoClient, GridFSBucket, ObjectId } = require('mongodb');
const { Readable } = require('stream');
const admin = require('firebase-admin');

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

    if (admin.apps.length === 0) {
        try {
            const serviceAccount = require('./serviceAccountKey.json');
            admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
            plugin.loginfo('Firebase Admin initialized successfully.');
        } catch (err) {
            plugin.logerror(`Failed to initialize Firebase: ${err.message}`);
        }
    }

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

// ─────────────────────────────────────────────────────────────────────────────
//  NUMERIC OTP EXTRACTION  –  compiled once at module load
// ─────────────────────────────────────────────────────────────────────────────

const OTP_KW = `(?:
  verification[\\s-]*code|one[\\s-]*time[\\s-]*(?:password|passcode|code)|
  auth(?:entication)?[\\s-]*code|security[\\s-]*code|
  \\b(?:otp|pin|token|passcode|access[\\s-]*code)\\b
)`.replace(/\s+/g, '');

const RE_KW_BEFORE   = new RegExp(`${OTP_KW}[^0-9a-zA-Z]{0,25}(\\d{4,8})`, 'i');
const RE_KW_AFTER    = new RegExp(`(?<![.\\w@#])(?<![\\d])(\\d{4,8})(?![.\\w@#%])(?:[^0-9]{0,40})${OTP_KW}`, 'i');
const RE_IS_YOUR_CODE = /(?<![.\w@#\/\-])(\d{4,8})(?![.\w@#\/\-])\s+is\s+your\s+(?:\w+\s+)?code\b/i;
const RE_SIX          = /(?<![.\w@#\/\-])(\d{6})(?![.\w@#\/\-])/;
const RE_FOUR_EIGHT   = /(?<![.\w@#\/\-])(\d{4}|\d{8})(?![.\w@#\/\-])/;

const OTP_REJECT = [
    /^\d{9,}$/,
    /^(?:19|20)\d{2}$/,
    /^\d+[,\.]\d+$/,
];

const RE_OTP_CONTEXT_GUARD = new RegExp(OTP_KW, 'i');

function extractNumericOtp(subject, textBody) {
    const sources = [subject, textBody].filter(Boolean);

    for (const src of sources) {
        let m = src.match(RE_KW_BEFORE);
        if (m && !OTP_REJECT.some(r => r.test(m[1]))) return m[1];

        m = src.match(RE_IS_YOUR_CODE);
        if (m && !OTP_REJECT.some(r => r.test(m[1]))) return m[1];

        m = src.match(RE_KW_AFTER);
        if (m && !OTP_REJECT.some(r => r.test(m[1]))) return m[1];
    }

    for (const src of sources) {
        if (!RE_OTP_CONTEXT_GUARD.test(src)) continue;

        let m = src.match(RE_SIX);
        if (m) {
            const cand = m[1];
            if (!OTP_REJECT.some(r => r.test(cand))) {
                const idx = src.indexOf(cand);
                const before = src.slice(Math.max(0, idx - 3), idx);
                if (/[\w.]$/.test(before)) continue;
                return cand;
            }
        }

        m = src.match(RE_FOUR_EIGHT);
        if (m) {
            const cand = m[1];
            if (!OTP_REJECT.some(r => r.test(cand))) {
                const idx = src.indexOf(cand);
                const before = src.slice(Math.max(0, idx - 3), idx);
                if (/[\w.]$/.test(before)) continue;
                return cand;
            }
        }
    }

    return null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  ALPHANUMERIC OTP EXTRACTION  –  compiled once at module load
//  Handles codes like: ZXH-QCS  AB12CD  AAA-BBB-CCC  XY9Z2A  A1B2
// ─────────────────────────────────────────────────────────────────────────────

// First-segment reject list: known non-code prefixes / common English fragments
const ALPHA_REJECT_PREFIX = /^(?:HTTP|HTTPS|REF|INV|ORD|API|URL|ID|UUID|SKU|FTP|DNS|TKT|MSG|SYS|IS|OF|TO|IN|AN|OR|BE|DO|GO)$/i;

// Prefix heuristic: pure-alpha single-segment codes whose first 3 letters look
// like a common English word stem are almost never OTP codes.
const ALPHA_WORD_STARTS = /^(?:SHI|VER|UPD|ERR|NOT|SEN|TRA|DEL|CON|ACC|DIS|EXP|MES|RES|STA|END|OPE|CLO|FIN|STR|COM|PRO)/i;

// One code segment: 2–8 uppercase alphanumeric chars
const SEG = '[A-Z0-9]{2,8}';
// Full code capture: 1–4 hyphen-separated segments
const CODE_CAP = `((?:${SEG})(?:-(?:${SEG})){0,3})`;

// P-A1: keyword + colon/dash immediately + code
// "code: ZXH-QCS"  "otp: AB12"  "token-AB-CD"
const RE_A1_STRICT = new RegExp(
    `(?:code|token|otp|pin|passcode)\\s*[:\\-]\\s*${CODE_CAP}(?=[\\s,;.\\n]|$)`, 'i'
);

// P-A2: keyword + optional "is" skip + single-space + code
// "code ABCDEF"  "code is ABC-123"  "code is: ABC-123"
const RE_A1_SPACE = new RegExp(
    `(?:code|token|otp|pin|passcode)\\s+(?:is\\s*[:\\-]?\\s*)?${CODE_CAP}(?=[\\s,;.\\n]|$)`, 'i'
);

// P-A3: keyword + 1–3 filler words (last may have colon) + code
// "OTP to login: ZZ1-22B"  "code sent via SMS: XK9"
const RE_A1_FILLER = new RegExp(
    `(?:code|token|otp|pin|passcode)\\s+(?:\\w+[\\s:]+){1,3}\\s*${CODE_CAP}(?=[\\s,;.\\n]|$)`, 'i'
);

// P-A4: hyphenated/segmented code BEFORE keyword phrase (code leads the subject)
// "ZXH-QCS xAI confirmation code"  "AB-CD-12 verification code"
const RE_A2 = new RegExp(
    `(?<![.@\\/\\w-])((?:${SEG})(?:-(?:${SEG})){1,3})(?![.@\\/\\w])` +
    `[^\\n]{0,80}` +
    `(?:confirmation\\s+code|verification\\s+code|access\\s+code|security\\s+code|one[\\s-]*time)`,
    'i'
);

// P-A5: "your [0–2 words] code is/: VALUE"
// "Your code is ABC-123"  "Your access code: AB12CD"  "Your code is AAA-BBB-CCC"
const RE_A3 = new RegExp(
    `your\\s+(?:\\w+\\s+){0,2}(?:code|otp|pin|token)\\s+(?:is\\s*[:\\-]?\\s*|[:\\-]\\s*)${CODE_CAP}(?=[\\s,;.\\n]|$)`,
    'i'
);

/**
 * Validate and normalise a raw candidate alpha code.
 * Returns uppercase code string, or null if it looks like a false positive.
 */
function validateAlphaCode(raw) {
    if (!raw) return null;
    const code = raw.replace(/[,;.\s]+$/, '').trim().toUpperCase();
    if (code.length < 2) return null;

    const firstSeg = code.split('-')[0];
    if (ALPHA_REJECT_PREFIX.test(code) || ALPHA_REJECT_PREFIX.test(firstSeg)) return null;

    const hasDigit  = /\d/.test(code);
    const hasHyphen = code.includes('-');

    // Pure alpha, single segment: apply stricter length + word-stem guard
    if (!hasDigit && !hasHyphen) {
        const len = code.length;
        if (len < 4 || len > 8) return null;
        if (ALPHA_WORD_STARTS.test(code)) return null;
    }

    // Reject version strings like "V2", "V12"
    if (/^V\d/.test(code)) return null;

    return code;
}

/**
 * Extract an alphanumeric OTP/code from subject and/or text body.
 * Returns the code string (uppercased) or null.
 * Runs BEFORE the numeric extractor in the combined extractOtp function.
 */
function extractAlphaOtp(subject, textBody) {
    const sources = [subject, textBody].filter(Boolean);
    for (const src of sources) {
        let m, v;

        m = RE_A1_STRICT.exec(src); v = validateAlphaCode(m?.[1]); if (v) return v;
        m = RE_A1_SPACE.exec(src);  v = validateAlphaCode(m?.[1]); if (v) return v;
        m = RE_A1_FILLER.exec(src); v = validateAlphaCode(m?.[1]); if (v) return v;
        m = RE_A2.exec(src);        v = validateAlphaCode(m?.[1]); if (v) return v;
        m = RE_A3.exec(src);        v = validateAlphaCode(m?.[1]); if (v) return v;
    }
    return null;
}

/**
 * Master OTP extractor.
 * Priority order:
 *   1. Alphanumeric patterns (new) — catches ZXH-QCS, AB12CD, etc.
 *   2. Numeric patterns (existing) — catches 847291, 1234, etc.
 * The alpha extractor runs first because a digit-heavy alpha code like "AB12"
 * could also match a numeric pattern incorrectly.
 */
function extractOtp(subject, textBody) {
    return extractAlphaOtp(subject, textBody) || extractNumericOtp(subject, textBody);
}

// ─────────────────────────────────────────────────────────────────────────────
//  VERIFICATION / MAGIC LINK EXTRACTION
// ─────────────────────────────────────────────────────────────────────────────

const RE_LINK_URL    = /\/(?:verif|confirm|activat|validat|magic|auth|reset|click|account\/activ|email\/verif|go\/?verify|check|optin|opt-in|double-opt|signup\/confirm)/i;
const RE_LINK_PARAM  = /[?&](?:token|code|key|hash|nonce|confirm|activate|verif)=/i;
const RE_LINK_TEXT   = /confirm|verif|activat|validat|magic\s+link|click\s+here|complete|authenticate|set\s+(?:up\s+)?(?:your\s+)?(?:account|password)|reset\s+password/i;
const RE_UNSUBSCRIBE = /unsubscri/i;

function scoreLinkCandidate(href, linkText) {
    let score = 0;
    if (RE_LINK_URL.test(href))   score += 10;
    if (RE_LINK_PARAM.test(href)) score += 6;
    if (RE_LINK_TEXT.test(linkText)) score += 4;
    if (RE_UNSUBSCRIBE.test(href) || RE_UNSUBSCRIBE.test(linkText)) score -= 20;
    return score;
}

function isValidHttp(href) {
    if (!href.startsWith('http')) return false;
    try { new URL(href); return true; } catch { return false; }
}

function extractVerificationLink(html, text) {
    let best = null;
    let bestScore = 0;

    if (html) {
        const aTag = /<a[^>]+href=["']([^"']{8,2000})["'][^>]*>([\s\S]{0,300}?)<\/a>/gi;
        let m;
        while ((m = aTag.exec(html)) !== null) {
            const href = m[1].trim();
            if (!isValidHttp(href)) continue;
            const linkText = m[2].replace(/<[^>]+>/g, ' ').trim();
            const s = scoreLinkCandidate(href, linkText);
            if (s > bestScore) { bestScore = s; best = href; }
        }
        if (bestScore >= 6) return best;

        const allHrefs = [...html.matchAll(/href=["']([^"']{8,2000})["']/gi)];
        for (const hm of allHrefs) {
            const href = hm[1].trim();
            if (!isValidHttp(href)) continue;
            const idx = html.indexOf(href);
            const ctx = html
                .slice(Math.max(0, idx - 150), idx + href.length + 150)
                .replace(/<[^>]+>/g, ' ');
            const s = scoreLinkCandidate(href, ctx);
            if (s > bestScore) { bestScore = s; best = href; }
        }
        if (bestScore >= 4) return best;
    }

    if (text) {
        const urlRe = /https?:\/\/[^\s"'<>\]]{10,}/g;
        let m;
        while ((m = urlRe.exec(text)) !== null) {
            const href = m[0].replace(/[.,;:)]+$/, '');
            if (!isValidHttp(href)) continue;
            const idx = text.indexOf(href);
            const ctx = text.slice(Math.max(0, idx - 250), idx + href.length + 250);
            const s = scoreLinkCandidate(href, ctx);
            if (s > bestScore) { bestScore = s; best = href; }
        }
    }

    return bestScore > 0 ? best : null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  PLAN HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function apiPlanToInternalPlan(apiPlan) {
    if (!apiPlan) return 'anonymous';
    const p = String(apiPlan).toLowerCase();
    if (p === 'growth' || p === 'enterprise') return 'pro';
    if (p === 'free') return 'anonymous';
    return 'free'; // developer, startup
}

async function getUserData(recipientEmail) {
    if (!db || !redisClient.isOpen) return { plan: 'anonymous', userId: null, isVerified: false };

    const normalized = recipientEmail.toLowerCase();
    const cacheKey   = `user_data_cache:${normalized}`;
    const ttl        = parseInt(plugin.cfg.main.plan_cache_ttl, 10) || 3600;

    try {
        const cachedData = await redisClient.get(cacheKey);
        if (cachedData) {
            const data = JSON.parse(cachedData);
            data.userId = data.userId ? new ObjectId(data.userId) : null;
            return data;
        }

        const parts           = normalized.split('@');
        const recipientDomain = parts.length > 1 ? parts[1] : '';
        let user, userData;

        user = await db.collection('users').findOne({ apiInboxes: normalized });
        if (user) {
            const internalPlan = apiPlanToInternalPlan(user.apiPlan);
            userData = { plan: internalPlan, userId: user._id, isVerified: false };
            await redisClient.set(cacheKey, JSON.stringify({ plan: internalPlan, userId: user._id.toString(), isVerified: false }), { EX: ttl });
            return userData;
        }

        user = await db.collection('users').findOne({ plan: 'pro', 'customDomains.domain': recipientDomain, 'customDomains.verified': true });
        if (user) {
            userData = { plan: 'pro', userId: user._id, isVerified: true };
            await redisClient.set(cacheKey, JSON.stringify({ plan: 'pro', userId: user._id.toString(), isVerified: true }), { EX: ttl });
            return userData;
        }

        user = await db.collection('users').findOne({ plan: 'pro', inboxes: normalized });
        if (user) {
            userData = { plan: 'pro', userId: user._id, isVerified: false };
            await redisClient.set(cacheKey, JSON.stringify({ plan: 'pro', userId: user._id.toString(), isVerified: false }), { EX: ttl });
            return userData;
        }

        user = await db.collection('users').findOne({ plan: 'free', inboxes: normalized });
        if (user) {
            userData = { plan: 'free', userId: user._id, isVerified: false };
            await redisClient.set(cacheKey, JSON.stringify({ plan: 'free', userId: user._id.toString(), isVerified: false }), { EX: ttl });
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

// ─────────────────────────────────────────────────────────────────────────────
//  QUEUE HOOK
// ─────────────────────────────────────────────────────────────────────────────

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
                    mailbox_size:     parseInt(plugin.cfg.main.pro_mailbox_size, 10),
                    mailbox_ttl:      null,
                    attachment_limit: parseInt(plugin.cfg.main.pro_attachment_limit_mb, 10) * 1024 * 1024,
                    save_to_mongo:    true,
                    use_gridfs:       true,
                };
            } else if (plan === 'free') {
                cfg = {
                    mailbox_size:     parseInt(plugin.cfg.main.free_mailbox_size, 10),
                    mailbox_ttl:      parseInt(plugin.cfg.main.free_mailbox_ttl, 10),
                    attachment_limit: parseInt(plugin.cfg.main.free_attachment_limit_mb, 10) * 1024 * 1024,
                    save_to_mongo:    false,
                    use_gridfs:       true,
                };
            } else {
                cfg = {
                    mailbox_size:     parseInt(plugin.cfg.main.anon_mailbox_size, 10),
                    mailbox_ttl:      parseInt(plugin.cfg.main.anon_mailbox_ttl, 10),
                    attachment_limit: 0,
                    save_to_mongo:    false,
                    use_gridfs:       false,
                };
            }

            const MAX_STORAGE_BYTES   = 5 * 1024 * 1024 * 1024;
            let currentStorageUsage   = 0;

            if (plan === 'pro' && userId) {
                currentStorageUsage = await getUserStorageUsage(userId);
                if (currentStorageUsage >= MAX_STORAGE_BYTES) {
                    plugin.logwarn(`User ${userId} has reached 5GB storage limit. Stripping all attachments.`);
                    cfg.attachment_limit = 0;
                }
            }

            const attachmentsForRedis = [];
            const attachmentsForMongo = [];
            let attachmentsRemoved    = false;
            let totalNewAttachmentSize = 0;

            for (const att of (parsed.attachments || [])) {
                if (att.size > cfg.attachment_limit) { attachmentsRemoved = true; continue; }

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
                        Readable.from(att.content).pipe(uploadStream)
                            .on('finish', resolve).on('error', reject);
                    });
                    attachmentsForRedis.push({ filename: att.filename, contentType: att.contentType, size: att.size, gridfs_id: uploadStream.id.toString() });
                    attachmentsForMongo.push({ gridfs_id: uploadStream.id, filename: att.filename, contentType: att.contentType, size: att.size });
                } else {
                    attachmentsForRedis.push({ filename: att.filename, contentType: att.contentType, size: att.size, content: att.content.toString('base64') });
                }
            }

            if (attachmentsRemoved) {
                const reason = (plan === 'pro' && currentStorageUsage >= MAX_STORAGE_BYTES)
                    ? "You have reached your 5GB storage limit. Please delete old emails to receive new attachments."
                    : "One or more attachments were removed due to size limits for your plan.";
                const notice = `<br><p><i>[${reason}]</i></p>`;
                parsed.html = parsed.html ? parsed.html + notice : parsed.textAsHtml + notice;
            }

            // ── Extract OTP and verification link ─────────────────────────────
            // extractOtp now handles both numeric (847291) and alphanumeric (ZXH-QCS, AB12CD) codes.
            // Pro users receive the actual value; free/anonymous receive a boolean teaser.
            const rawOtp              = extractOtp(parsed.subject, parsed.text);
            const rawVerificationLink = extractVerificationLink(parsed.html || parsed.textAsHtml, parsed.text);

            let otp, verificationLink;
            if (plan === 'pro') {
                otp              = rawOtp;
                verificationLink = rawVerificationLink;
                if (otp)              plugin.logdebug(`OTP extracted for ${destination}: ${otp}`);
                if (verificationLink) plugin.logdebug(`Verification link extracted for ${destination}`);
            } else {
                otp              = rawOtp              ? '__DETECTED__' : null;
                verificationLink = rawVerificationLink ? '__DETECTED__' : null;
                if (otp)              plugin.logdebug(`OTP detected (not revealed) for ${destination} on plan ${plan}`);
                if (verificationLink) plugin.logdebug(`Verification link detected (not revealed) for ${destination} on plan ${plan}`);
            }

            const messageId        = shortid.generate();
            const messageDate      = new Date();
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
                otp,
                verificationLink,
            };

            if (cfg.save_to_mongo && userId) {
                db.collection('saved_emails').insertOne({
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
                    otp,
                    verificationLink,
                }).catch(err => plugin.logerror(`MongoDB insertOne failed for ${destination}: ${err}`));
            }

            const indexKey   = `maildrop:${plan}:${destination}:index`;
            const dataKey    = `maildrop:${plan}:${destination}:data`;
            const currentSize = await redisClient.zCard(indexKey);
            const multi      = redisClient.multi();

            if (currentSize >= cfg.mailbox_size) {
                const numToRemove = (currentSize - cfg.mailbox_size) + 1;
                const oldIds      = await redisClient.zRange(indexKey, 0, numToRemove - 1);
                if (oldIds?.length > 0) {
                    if (cfg.use_gridfs && userId) {
                        for (const oldId of oldIds) {
                            const oldMsg = await redisClient.hGet(dataKey, oldId);
                            if (oldMsg) {
                                try {
                                    const msg = JSON.parse(oldMsg);
                                    for (const att of (msg.attachments || [])) {
                                        if (att.gridfs_id) await gfs.delete(new ObjectId(att.gridfs_id));
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
            multi.zAdd('admin:emails:index', { score: messageTimestamp, value: `${plan}:${destination}:${messageId}` });
            multi.zRemRangeByRank('admin:emails:index', 0, -(100_001));

            if (cfg.mailbox_ttl) {
                multi.expire(indexKey, cfg.mailbox_ttl);
                multi.expire(dataKey,  cfg.mailbox_ttl);
            }

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
                otp,
                verificationLink,
            }));

            if (userId) {
                db.collection('users').findOne({ _id: userId }, { projection: { fcmToken: 1 } })
                    .then(userRecord => {
                        if (!userRecord?.fcmToken) return;

                        let bodyText = `New email from ${parsed.from?.text || 'Unknown'}`;
                        if (otp && plan === 'pro') bodyText = `Code: ${otp}`;
                        else if (otp)              bodyText = `Verification code detected!`;

                        admin.messaging().send({
                            token: userRecord.fcmToken,
                            data: {
                                type: 'new_mail',
                                title: parsed.subject || 'New Message',
                                body: bodyText,
                                mailbox: destination,
                                messageId: fullMessage.id,
                                otp:              otp              || '',
                                verificationLink: verificationLink || '',
                            },
                            android: { priority: 'high' },
                        })
                        .then(response => plugin.logdebug(`FCM sent to ${destination}: ${response}`))
                        .catch(err => {
                            if (err.code === 'messaging/registration-token-not-registered') {
                                db.collection('users').updateOne({ _id: userId }, { $unset: { fcmToken: "" } });
                            }
                            plugin.logerror(`FCM failed for ${destination}: ${err.message}`);
                        });
                    })
                    .catch(err => plugin.logerror(`Error fetching user for FCM: ${err}`));
            }

            await multi.exec();
            plugin.loginfo(`Successfully queued message ${messageId} for ${destination} to plan '${plan}'`);
        }
        next(OK);
    } catch (err) {
        plugin.logerror(`Critical error in tiered_save: ${err.stack}`);
        next(DENYSOFT, "Error processing message.");
    }
};