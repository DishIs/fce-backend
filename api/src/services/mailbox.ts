// api/src/services/mailbox.ts
import { client } from '../config/redis';
import bigInt from "big-integer";
import ratelimit from "./ratelimit";
import { gfs, db } from '../config/mongo';
import { Readable } from 'stream';
import { ObjectId } from 'mongodb';
import * as jwt from 'jsonwebtoken';

const ALTINBOX_MOD: number = parseInt(process.env.ALTINBOX_MOD || "20190422");
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-key';

interface UserJwtPayload {
    id: string;
    plan: 'pro' | 'free';
    iat: number;
    exp: number;
}

function getPlanFromRequest(req: any): 'pro' | 'free' | 'anonymous' {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        try {
            const decoded = jwt.verify(token, JWT_SECRET) as UserJwtPayload;
            return decoded.plan || 'anonymous';
        } catch (error: any) {
            console.warn("JWT verification failed:", error.message);
            return 'anonymous';
        }
    }
    return 'anonymous';
}

// ─────────────────────────────────────────────────────────────────────────────
// MongoDB Fallback Helpers (Pro users only)
// ─────────────────────────────────────────────────────────────────────────────

async function hydrateAttachments(attachments: any[]): Promise<any[]> {
    if (!attachments || attachments.length === 0) return attachments;
    return Promise.all(attachments.map(async (att) => {
        const gridfsId = att.gridfs_id || att.gridfsId;
        if (!gridfsId) return att;
        try {
            const downloadStream = gfs.openDownloadStream(
                typeof gridfsId === 'string' ? new ObjectId(gridfsId) : gridfsId
            );
            const chunks: Uint8Array[] = [];
            for await (const chunk of downloadStream) chunks.push(chunk);
            return {
                ...att,
                content: Buffer.concat(chunks).toString('base64'),
                gridfs_id: undefined,
                gridfsId: undefined,
            };
        } catch (err) {
            console.error(`Failed to hydrate attachment ${gridfsId}:`, err);
            return att;
        }
    }));
}

async function getInboxFromMongo(mailbox: string): Promise<any[]> {
    if (!db) return [];
    try {
        const docs = await db.collection('saved_emails')
            .find({ mailbox })
            .sort({ date: -1 })
            .limit(200)
            .project({
                messageId: 1,
                from: 1,
                to: 1,
                subject: 1,
                date: 1,
                'attachments.filename': 1,
                wasAttachmentStripped: 1,
                otp: 1,             // ── pass-through pro field
                verificationLink: 1, // ── pass-through pro field
            })
            .toArray();

        return docs.map(doc => ({
            id: doc.messageId,
            from: typeof doc.from === 'object' ? doc.from?.text || doc.from?.value?.[0]?.address : doc.from,
            to: mailbox,
            subject: doc.subject,
            date: doc.date instanceof Date ? doc.date.toISOString() : doc.date,
            hasAttachment: Array.isArray(doc.attachments) && doc.attachments.length > 0,
            wasAttachmentStripped: !!doc.wasAttachmentStripped,
            otp: doc.otp ?? null,
            verificationLink: doc.verificationLink ?? null,
            _source: 'mongo',
        }));
    } catch (err) {
        console.error(`MongoDB getInbox failed for ${mailbox}:`, err);
        return [];
    }
}

async function getMessageFromMongo(mailbox: string, id: string): Promise<any | null> {
    if (!db) return null;
    try {
        const doc = await db.collection('saved_emails').findOne({ mailbox, messageId: id });
        if (!doc) return null;
        const hydratedAttachments = await hydrateAttachments(doc.attachments || []);
        return {
            id: doc.messageId,
            from: typeof doc.from === 'object' ? doc.from?.text || doc.from?.value?.[0]?.address : doc.from,
            to: mailbox,
            subject: doc.subject,
            date: doc.date instanceof Date ? doc.date.toISOString() : doc.date,
            html: doc.html,
            text: doc.text,
            hasAttachment: hydratedAttachments.length > 0,
            attachments: hydratedAttachments,
            otp: doc.otp ?? null,
            verificationLink: doc.verificationLink ?? null,
        };
    } catch (err) {
        console.error(`MongoDB getMessage failed for ${mailbox}/${id}:`, err);
        return null;
    }
}

async function deleteMessageFromMongo(mailbox: string, id: string): Promise<boolean> {
    if (!db) return false;
    try {
        const doc = await db.collection('saved_emails').findOne({ mailbox, messageId: id });
        if (!doc) return false;
        if (doc.attachments && doc.attachments.length > 0) {
            await Promise.allSettled(
                doc.attachments
                    .filter((att: any) => att.gridfs_id || att.gridfsId)
                    .map(async (att: any) => {
                        const gfsId = att.gridfs_id || att.gridfsId;
                        try {
                            await gfs.delete(typeof gfsId === 'string' ? new ObjectId(gfsId) : gfsId);
                        } catch (err) {
                            console.warn(`Could not delete GridFS file ${gfsId}:`, err);
                        }
                    })
            );
        }
        await db.collection('saved_emails').deleteOne({ mailbox, messageId: id });
        return true;
    } catch (err) {
        console.error(`MongoDB deleteMessage failed for ${mailbox}/${id}:`, err);
        return false;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Core mailbox operations
// ─────────────────────────────────────────────────────────────────────────────

export async function getInbox(
    mailbox: string,
    plan: 'pro' | 'free' | 'anonymous'
): Promise<Array<object>> {
    console.log(`getting mailbox summaries for ${mailbox} on plan ${plan}`);

    const indexKey = `maildrop:${plan}:${mailbox}:index`;
    const dataKey = `maildrop:${plan}:${mailbox}:data`;

    try {
        let rawResults: string[] = [];

        const messageIds = await client.zRange(indexKey, 0, -1, { REV: true });
        if (messageIds && messageIds.length > 0) {
            const planResults = await client.hmGet(dataKey, messageIds);
            rawResults = rawResults.concat(planResults.filter((r): r is string => r !== null));
        }

        if (plan !== 'anonymous') {
            const anonIndex = `maildrop:anonymous:${mailbox}:index`;
            const anonData = `maildrop:anonymous:${mailbox}:data`;
            const anonIds = await client.zRange(anonIndex, 0, -1, { REV: true });
            if (anonIds && anonIds.length > 0) {
                const anonResults = await client.hmGet(anonData, anonIds);
                rawResults = rawResults.concat(anonResults.filter((r): r is string => r !== null));
            }
        }

        let mongoResults: any[] = [];
        if (plan === 'pro') {
            mongoResults = await getInboxFromMongo(mailbox);
        }

        // Parse Redis results — pass through otp + verificationLink if present
        const parsedFromRedis = rawResults.map((result: string) => {
            const message = JSON.parse(result);
            return {
                id: message.id,
                from: message.from,
                to: message.to,
                subject: message.subject,
                date: message.date,
                hasAttachment: message.hasAttachment,
                wasAttachmentStripped: !!message.wasAttachmentStripped,
                otp: message.otp ?? null,
                verificationLink: message.verificationLink ?? null,
                _source: 'redis',
            };
        });

        const redisIds = new Set(parsedFromRedis.map(m => m.id));
        const mongoOnly = mongoResults.filter(m => !redisIds.has(m.id));
        const merged = [...parsedFromRedis, ...mongoOnly];

        return merged
            .map(({ _source, ...rest }) => rest)
            .sort((a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime());

    } catch (error) {
        console.error(`Error in getInbox for ${mailbox} (${plan}):`, error);
        throw new Error('Failed to retrieve messages');
    }
}

export async function getMessage(
    mailbox: string,
    id: string,
    plan: 'pro' | 'free' | 'anonymous'
): Promise<any> {
    console.log(`getting message ${id} from mailbox ${mailbox} on plan ${plan}`);
    const dataKey = `maildrop:${plan}:${mailbox}:data`;

    try {
        let messageStr = await client.hGet(dataKey, id);

        if (!messageStr && plan !== 'anonymous') {
            const anonDataKey = `maildrop:anonymous:${mailbox}:data`;
            messageStr = await client.hGet(anonDataKey, id);
        }

        if (messageStr) {
            const message = JSON.parse(messageStr);
            if (message.attachments && message.attachments.length > 0) {
                message.attachments = await hydrateAttachments(message.attachments);
            }
            // otp + verificationLink already embedded in stored JSON — returned as-is
            return message;
        }

        if (plan === 'pro') {
            return await getMessageFromMongo(mailbox, id);
        }

        return null;
    } catch (error) {
        console.error(`Error getting message ${id} (${plan}):`, error);
        throw new Error('Failed to retrieve message');
    }
}

export async function deleteMessageById(
    mailbox: string,
    id: string,
    plan: 'pro' | 'free' | 'anonymous'
): Promise<boolean> {
    console.log(`deleting message ${id} from mailbox ${mailbox} on plan ${plan}`);
    const indexKey = `maildrop:${plan}:${mailbox}:index`;
    const dataKey = `maildrop:${plan}:${mailbox}:data`;

    try {
        const messageStr = await client.hGet(dataKey, id);
        if (messageStr) {
            try {
                const msg = JSON.parse(messageStr);
                if (msg.attachments) {
                    await Promise.allSettled(
                        msg.attachments
                            .filter((att: any) => att.gridfs_id)
                            .map((att: any) =>
                                gfs.delete(new ObjectId(att.gridfs_id)).catch(() => { })
                            )
                    );
                }
            } catch (_) { }
        }

        const [, hdelResult] = await client.multi()
            .zRem(indexKey, id)
            .hDel(dataKey, id)
            .exec();
        let deleted = Number(hdelResult) > 0;

        if (!deleted && plan !== 'anonymous') {
            const anonIndex = `maildrop:anonymous:${mailbox}:index`;
            const anonData = `maildrop:anonymous:${mailbox}:data`;
            const [, anonHdelResult] = await client.multi()
                .zRem(anonIndex, id)
                .hDel(anonData, id)
                .exec();
            deleted = Number(anonHdelResult) > 0;
        }

        if (plan === 'pro') {
            const mongoDeleted = await deleteMessageFromMongo(mailbox, id);
            deleted = deleted || mongoDeleted;
        }

        return deleted;
    } catch (error) {
        console.error(`Error deleting message ${id} (${plan}):`, error);
        return false;
    }
}

export function encryptMailbox(mailbox: string): string {
    const num = bigInt(mailbox.toLowerCase().replace(/[^0-9a-z]/gi, ''), 36);
    const encryptedNum = bigInt(`1${num.toString().split("").reverse().join("")}`).add(ALTINBOX_MOD);
    return `D-${encryptedNum.toString(36)}`;
}

export async function listHandler(req: any, res: any): Promise<any> {
    const ip = req.ip;
    const mailbox = req.params.name;
    const plan = getPlanFromRequest(req);
    try {
        await ratelimit(ip);
        const results = await getInbox(mailbox, plan);
        return res.status(200).set({
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Credentials': 'true',
        }).json({
            success: true,
            message: "Mailbox retrieved successfully.",
            data: results,
            encryptedMailbox: encryptMailbox(mailbox),
        });
    } catch (reason: any) {
        console.error(`listHandler error for ${ip}:`, reason);
        return res.status(500).set({
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Credentials': 'true',
        }).json({ success: false, message: "An error occurred.", errorDetails: reason.toString() });
    }
}

export async function messageHandler(req: any, res: any): Promise<any> {
    const ip = req.ip;
    const mailbox = req.params.name;
    const id = req.params.id;
    const plan = getPlanFromRequest(req);
    try {
        await ratelimit(ip);
        const messageData = await getMessage(mailbox, id, plan);
        if (!messageData) {
            return res.status(200).json({ success: false, message: "Message not found." });
        }
        return res.status(200).set({
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Credentials': 'true',
        }).json({ success: true, message: "Message retrieved successfully.", data: messageData });
    } catch (reason: any) {
        console.error(`messageHandler error for ${ip}:`, reason);
        return res.status(500).json({ success: false, message: "An error occurred.", errorDetails: reason.toString() });
    }
}

export async function deleteHandler(req: any, res: any): Promise<any> {
    const ip = req.ip;
    const mailbox = req.params.name;
    const id = req.params.id;
    const plan = getPlanFromRequest(req);
    try {
        await ratelimit(ip);
        const deleted = await deleteMessageById(mailbox, id, plan);
        if (!deleted) {
            return res.status(200).json({ success: false, message: "Message not found or already deleted." });
        }
        return res.status(200).set({
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Credentials': 'true',
        }).json({ success: true, message: "Message deleted successfully." });
    } catch (reason: any) {
        console.error(`deleteHandler error for ${ip}:`, reason);
        return res.status(500).json({ success: false, message: "Failed to delete message.", errorDetails: reason.toString() });
    }
}