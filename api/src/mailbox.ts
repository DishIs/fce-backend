import {client} from "./redis";
import bigInt from "big-integer";
import ratelimit from "./ratelimit";
import { gfs } from './mongo'; // Import GridFS bucket
import { Readable } from 'stream';

const ALTINBOX_MOD: number = parseInt(process.env.ALTINBOX_MOD || "20190422");

export function getInbox(mailbox: string): Promise<Array<object>> {
  console.log(`getting mailbox ${mailbox}`);
  return client.lRange(`mailbox:${mailbox}`, 0, -1).then((results: any[]) => {
    if (!results || results.length === 0) {
      console.log(`No mailbox found: ${mailbox}`);
    }
    console.log(`Found ${results.length} messages in mailbox ${mailbox}`);
    return results.map((result: string) => JSON.parse(result));
  }).catch((error: any) => {
    console.error('Error during Redis lRange:', error);
    throw new Error('Failed to retrieve messages from Redis');
  });

}

export function getMessage(mailbox: string, id: string): Promise<any> {
  return client.lRange(`mailbox:${mailbox}:body`, 0, -1).then(async (results: any[]) => {
    const messageStr = results.find((result: string) => JSON.parse(result).id === id);
    if (!messageStr) {
        return {};
    }
    
    let message = JSON.parse(messageStr);

    // If attachments are stored in GridFS, retrieve them
    if (message.attachments && message.attachments.length > 0) {
        for (let i = 0; i < message.attachments.length; i++) {
            const att = message.attachments[i];
            if (att.gridfs_id) {
                const downloadStream = gfs.openDownloadStream(att.gridfs_id);
                const chunks: Buffer[] = [];
                for await (const chunk of downloadStream) {
                    chunks.push(chunk);
                }
                // Return content as base64, just like Haraka does for smaller attachments
                att.content = Buffer.concat(chunks).toString('base64');
                delete att.gridfs_id; // Clean up the response
            }
        }
    }

    return message;
  });
}



export function getMessageIndex(key: string, id: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    client.lRange(key, 0, -1).then((results: any[]) => {

      const index = results.findIndex((result: string) => JSON.parse(result).id === id);
      resolve(index);
    });
  });
}


export function deleteMessage(key: string, index: number): Promise<void> {
  return client.multi().lSet(key, index, '__deleted__').lRem(key, 0, '__deleted__').exec().then(() => {
    return;
  }).catch((error: any) => {
    return Promise.reject(error);
  });
}

export function deleteBoth(mailbox: string, id: string): Promise<boolean> {
  const listKey = `mailbox:${mailbox}`;
  const bodyKey = `mailbox:${mailbox}:body`;
  return Promise.all([
    getMessageIndex(listKey, id).then((index) => deleteMessage(listKey, index)),
    getMessageIndex(bodyKey, id).then((index) => deleteMessage(bodyKey, index))
  ]).then(() => true, () => false);
}

export function encryptMailbox(mailbox: string): string {
  // - Strip non alpha-numeric characters
  // - Convert the regular inbox to a long
  // - Reverse the digits and prepend a 1
  // - Add the private modifier
  // - Convert back to base36
  // - Prepend prefix
  const num = bigInt(mailbox.toLowerCase().replace(/[^0-9a-z]/gi, ''), 36);
  const encryptedNum = bigInt(`1${num.toString().split("").reverse().join("")}`).add(ALTINBOX_MOD);
  return `D-${encryptedNum.toString(36)}`;
}

export async function listHandler(req: any, res: any): Promise<any> {
  const ip = req.ip;
  const mailbox = req.params.name;  
  try {
    await ratelimit(ip);
    console.log(`client ${ip} requesting mailbox ${mailbox}`);
    const results = await getInbox(mailbox);
    const encryptedMailbox = encryptMailbox(mailbox);
    
    // Constructing the response object
      const response = {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Credentials': true,
        },
        body: {
          success: true,
          message: "Mailbox retrieved successfully.",
          data: results,
          encryptedMailbox, // Return the encrypted mailbox identifier
        },
      };
      return res.status(200).set(response.headers).json(response.body);
  } catch (reason) {
    console.log(`error for ${ip} : ${reason}`);
    const errorResponse = {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': true,
      },
      body: {
        success: false,
        message: "An error occurred.",
        errorDetails: reason,
      },
    };
    return res.status(500).set(errorResponse.headers).json(errorResponse.body);
  }
}

export async function messageHandler(req: any, res: any): Promise<any> {
  const ip = req.ip;
  const mailbox = req.params.name;
  const id = req.params.id;  
  try {
    await ratelimit(ip);
    console.log(`client ${ip} requesting mailbox ${mailbox} id ${id}`);
    
    // The result from getMessage is already the fully parsed object we need
    const messageData = await getMessage(mailbox, id);

    const encryptedMailbox = encryptMailbox(mailbox);
    console.log(messageData);
    
    // Check if the message exists
    if (Object.keys(messageData).length === 0) {
      const notFoundResponse = {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Credentials': true,
        },
        body: {
          success: false,
          message: "Message not found.",
          details: { mailbox: encryptedMailbox, id },
        },
      };
       return res.status(200).set(notFoundResponse.headers).json(notFoundResponse.body);
    }
    
    const response = {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': true,
      },
      body: {
        success: true,
        message: "Message retrieved successfully.",
        data: messageData, // Use the data directly
        encryptedMailbox,
      },
    };

    return res.status(200).set(response.headers).json(response.body);
  } catch (reason) {
    console.log(`error for ${ip} : ${reason}`);
    const errorResponse = {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': true,
      },
      body: {
        success: false,
        message: "An error occurred while retrieving the message.",
        errorDetails: reason,
      },
    };
    return res.status(500).set(errorResponse.headers).json(errorResponse.body);
  }
}

export async function deleteHandler(req: any, res: any): Promise<any> {
  const ip = req.ip;
  const mailbox = req.params.name;
  const id = req.params.id;  
  try {
    await ratelimit(ip);
    console.log(`client ${ip} deleting mailbox ${mailbox} id ${id}`);
    const deleted = await deleteBoth(mailbox, id);
    
    // Check if the message was deleted successfully
    if (!deleted) {
      const encryptedMailbox = encryptMailbox(mailbox);
      const notFoundResponse = {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Credentials': true,
        },
        body: {
          success: false,
          message: "Message not found or failed to delete.",
          details: { mailbox: encryptedMailbox, id },
        },
      };
      return res.status(200).set(notFoundResponse.headers).json(notFoundResponse.body);
    }

    const response = {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': true,
      },
      body: {
        success: true,
        message: "Message deleted successfully.",
        data: { deleted },
        mailbox: encryptMailbox(mailbox), // Include encrypted mailbox
      },
    };

    return res.status(200).set(response.headers).json(response.body);
  } catch (reason) {
    console.log(`error for ${ip} : ${reason}`);
    const errorResponse = {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': true,
      },
      body: {
        success: false,
        message: "Failed to delete message.",
        errorDetails: reason,
        mailbox: encryptMailbox(mailbox), // Include encrypted mailbox
      },
    };
    return res.status(500).set(errorResponse.headers).json(errorResponse.body);
  }
}
