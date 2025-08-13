import { client } from "./redis";
import bigInt from "big-integer";
import ratelimit from "./ratelimit";
import { gfs } from './mongo';
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
        const token = authHeader.substring(7, authHeader.length);
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

/**
 * Gets a list of message summaries for a mailbox, based on the user's plan.
 */
export async function getInbox(mailbox: string, plan: 'pro' | 'free' | 'anonymous'): Promise<Array<object>> {
    console.log(`getting mailbox summaries for ${mailbox} on plan ${plan}`);
    const indexKey = `maildrop:${plan}:${mailbox}:index`;
    const dataKey = `maildrop:${plan}:${mailbox}:data`;

    try {
        const messageIds = await client.zRange(indexKey, 0, -1, { REV: true });

        if (!messageIds || messageIds.length === 0) {
            return [];
        }

        const results = await client.hmGet(dataKey, messageIds);

        // --- REVISED: The mapping function now includes 'wasAttachmentStripped' ---
        return results
            .filter(r => r)
            .map((result: string) => {
                const message = JSON.parse(result);
                return {
                    id: message.id, from: message.from, to: message.to,
                    subject: message.subject, date: message.date, hasAttachment: message.hasAttachment,
                    wasAttachmentStripped: !!message.wasAttachmentStripped, // <-- Add the flag here, ensuring it's a boolean
                };
            });
    } catch (error) {
        console.error(`Error in getInbox on ${mailbox} (${plan}):`, error);
        throw new Error('Failed to retrieve messages from Redis');
    }
}

/**
 * Gets a single, complete message object by its ID, based on the user's plan.
 */
export async function getMessage(mailbox: string, id: string, plan: 'pro' | 'free' | 'anonymous'): Promise<any> {
    console.log(`getting message ${id} from mailbox ${mailbox} on plan ${plan}`);
    const dataKey = `maildrop:${plan}:${mailbox}:data`;

    try {
        const messageStr = await client.hGet(dataKey, id);
        if (!messageStr) {
            return null;
        }
        
        let message = JSON.parse(messageStr);

        if (message.attachments && message.attachments.length > 0) {
            for (const att of message.attachments) {
                if (att.gridfs_id) {
                    const downloadStream = gfs.openDownloadStream(new ObjectId(att.gridfs_id));
                    const chunks: Buffer[] = [];
                    for await (const chunk of downloadStream) {
                        chunks.push(chunk);
                    }
                    att.content = Buffer.concat(chunks).toString('base64');
                    delete att.gridfs_id;
                }
            }
        }
        return message;
    } catch (error) {
        console.error(`Error getting message ${id} (${plan}):`, error);
        throw new Error('Failed to retrieve message from Redis');
    }
}

/**
 * Deletes a message by its ID, based on the user's plan.
 */
export async function deleteMessageById(mailbox: string, id: string, plan: 'pro' | 'free' | 'anonymous'): Promise<boolean> {
    console.log(`deleting message ${id} from mailbox ${mailbox} on plan ${plan}`);
    const indexKey = `maildrop:${plan}:${mailbox}:index`;
    const dataKey = `maildrop:${plan}:${mailbox}:data`;

    try {
        const [, hdelResult] = await client.multi()
            .zRem(indexKey, id)
            .hDel(dataKey, id)
            .exec();
        
        return Number(hdelResult) > 0;
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
        console.log(`error for ${ip} : ${reason}`);
        return res.status(500).set({
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Credentials': 'true',
        }).json({
            success: false, message: "An error occurred.",
            errorDetails: reason.toString(),
        });
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
            return res.status(200).json({
                success: false, message: "Message not found in your current plan.",
            });
        }
        
        return res.status(200).set({
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Credentials': 'true',
        }).json({
            success: true, message: "Message retrieved successfully.",
            data: messageData,
        });
    } catch (reason: any) {
        console.log(`error for ${ip} : ${reason}`);
        return res.status(500).json({
            success: false, message: "An error occurred while retrieving the message.",
            errorDetails: reason.toString(),
        });
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
            return res.status(200).json({
                success: false, message: "Message not found or already deleted.",
            });
        }

        return res.status(200).set({
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Credentials': 'true',
        }).json({
            success: true, message: "Message deleted successfully.",
        });
    } catch (reason: any) {
        console.log(`error for ${ip} : ${reason}`);
        return res.status(500).json({
            success: false, message: "Failed to delete message.",
            errorDetails: reason.toString(),
        });
    }
}