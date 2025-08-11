// /home/dit/maildrop/api/src/mailbox.ts
import { client } from "./redis";
import bigInt from "big-integer";
import ratelimit from "./ratelimit";
import { gfs } from './mongo'; // Assuming gfs is correctly initialized GridFSBucket
import { Readable } from 'stream';
import { ObjectId } from 'mongodb';

const ALTINBOX_MOD: number = parseInt(process.env.ALTINBOX_MOD || "20190422");

// --- REFACTORED: Data Access Functions ---

/**
 * Gets a list of message summaries for a mailbox, newest first.
 * Retrieves message IDs from the Sorted Set and fetches corresponding data from the Hash.
 */
export async function getInbox(mailbox: string): Promise<Array<object>> {
    console.log(`getting mailbox summaries for ${mailbox}`);
    const indexKey = `mailbox:${mailbox}:index`;
    const dataKey = `mailbox:${mailbox}:data`;

    try {
        // --- FIX APPLIED HERE ---
        // Instead of the incorrectly typed zRevRange, use zRange with the REV option.
        // This achieves the same result (getting newest first) and is fully type-supported.
        const messageIds = await client.zRange(indexKey, 0, -1, { REV: true });

        if (!messageIds || messageIds.length === 0) {
            console.log(`No messages found in mailbox: ${mailbox}`);
            return [];
        }

        // Fetch all message bodies in one go using HMGET
        const results = await client.hmGet(dataKey, messageIds);

        // Filter out null results and parse the JSON.
        return results
            .filter(r => r) // Ensure result is not null
            .map((result: string) => {
                const message = JSON.parse(result);
                // Construct the summary object
                return {
                    id: message.id,
                    from: message.from,
                    to: message.to,
                    subject: message.subject,
                    date: message.date,
                    hasAttachment: message.hasAttachment,
                };
            });

    } catch (error) {
        console.error(`Error during Redis operations for getInbox on ${mailbox}:`, error);
        throw new Error('Failed to retrieve messages from Redis');
    }
}

/**
 * Gets a single, complete message object by its ID.
 * Uses a direct HGET for maximum efficiency.
 */
export async function getMessage(mailbox: string, id: string): Promise<any> {
    console.log(`getting message ${id} from mailbox ${mailbox}`);
    const dataKey = `mailbox:${mailbox}:data`;

    try {
        const messageStr = await client.hGet(dataKey, id);
        if (!messageStr) {
            return null; // Return null to indicate not found
        }
        
        let message = JSON.parse(messageStr);

        // If attachments are stored in GridFS, retrieve them
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
        console.error(`Error during Redis hGet for message ${id}:`, error);
        throw new Error('Failed to retrieve message from Redis');
    }
}

/**
 * Deletes a message by its ID from both the index and data stores.
 */
export async function deleteMessageById(mailbox: string, id: string): Promise<boolean> {
    console.log(`deleting message ${id} from mailbox ${mailbox}`);
    const indexKey = `mailbox:${mailbox}:index`;
    const dataKey = `mailbox:${mailbox}:data`;

    try {
        const [, hdelResult] = await client.multi()
            .zRem(indexKey, id)
            .hDel(dataKey, id)
            .exec();
        
        return Number(hdelResult) > 0;
    } catch (error) {
        console.error(`Error during Redis multi-delete for message ${id}:`, error);
        return false;
    }
}

// (The encryptMailbox function remains unchanged)
export function encryptMailbox(mailbox: string): string {
  const num = bigInt(mailbox.toLowerCase().replace(/[^0-9a-z]/gi, ''), 36);
  const encryptedNum = bigInt(`1${num.toString().split("").reverse().join("")}`).add(ALTINBOX_MOD);
  return `D-${encryptedNum.toString(36)}`;
}


// --- REFACTORED: API Handlers (No changes needed here) ---

export async function listHandler(req: any, res: any): Promise<any> {
    const ip = req.ip;
    const mailbox = req.params.name;  
    try {
        await ratelimit(ip);
        const results = await getInbox(mailbox);
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
            success: false,
            message: "An error occurred.",
            errorDetails: reason.toString(),
        });
    }
}

export async function messageHandler(req: any, res: any): Promise<any> {
    const ip = req.ip;
    const mailbox = req.params.name;
    const id = req.params.id;  
    try {
        await ratelimit(ip);
        const messageData = await getMessage(mailbox, id);

        if (!messageData) {
            return res.status(200).set({
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Credentials': 'true',
            }).json({
                success: false,
                message: "Message not found.",
                details: { mailbox: encryptMailbox(mailbox), id },
            });
        }
        
        return res.status(200).set({
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Credentials': 'true',
        }).json({
            success: true,
            message: "Message retrieved successfully.",
            data: messageData,
            encryptedMailbox: encryptMailbox(mailbox),
        });
    } catch (reason: any) {
        console.log(`error for ${ip} : ${reason}`);
        return res.status(500).set({
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Credentials': 'true',
        }).json({
            success: false,
            message: "An error occurred while retrieving the message.",
            errorDetails: reason.toString(),
        });
    }
}

export async function deleteHandler(req: any, res: any): Promise<any> {
    const ip = req.ip;
    const mailbox = req.params.name;
    const id = req.params.id;  
    try {
        await ratelimit(ip);
        const deleted = await deleteMessageById(mailbox, id);

        if (!deleted) {
            return res.status(200).set({
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Credentials': 'true',
            }).json({
                success: false,
                message: "Message not found or already deleted.",
                details: { mailbox: encryptMailbox(mailbox), id },
            });
        }

        return res.status(200).set({
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Credentials': 'true',
        }).json({
            success: true,
            message: "Message deleted successfully.",
            mailbox: encryptMailbox(mailbox),
        });
    } catch (reason: any) {
        console.log(`error for ${ip} : ${reason}`);
        return res.status(500).set({
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Credentials': 'true',
        }).json({
            success: false,
            message: "Failed to delete message.",
            errorDetails: reason.toString(),
            mailbox: encryptMailbox(mailbox),
        });
    }
}