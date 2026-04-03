// api/src/handlers/internal-webhooks.ts
import { Request, Response } from 'express';
import { db } from '../config/mongo';
import { ObjectId } from 'mongodb';
import crypto from 'crypto';

export async function addWebhookHandler(req: Request, res: Response): Promise<any> {
  const { wyiUserId, url, inbox } = req.body;

  if (!wyiUserId || !url || !inbox) {
    return res.status(400).json({
      success: false,
      error: 'missing_fields',
      message: 'wyiUserId, url, and inbox are required',
    });
  }

  const normalizedInbox = String(inbox).trim().toLowerCase();

  const user = await db.collection('users').findOne({
    $or: [
      { wyiUserId, apiInboxes: normalizedInbox },
      { wyiUserId, inboxes: normalizedInbox },
      { linkedProviderIds: wyiUserId, apiInboxes: normalizedInbox },
      { linkedProviderIds: wyiUserId, inboxes: normalizedInbox },
    ],
  });

  if (!user) {
    return res.status(403).json({
      success: false,
      error: 'inbox_not_owned',
      message: `Inbox "${inbox}" is not registered for this user.`,
    });
  }

  const secret = crypto.randomBytes(32).toString('hex');

  try {
    const doc = {
      wyiUserId,
      inbox: normalizedInbox,
      url,
      secret,
      createdAt: new Date(),
      active: true,
      failureCount: 0,
    };

    const result = await db.collection('webhooks').insertOne(doc);

    return res.status(201).json({
      success: true,
      id: result.insertedId.toString(),
      inbox: doc.inbox,
      url: doc.url,
      secret: secret,
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: 'server_error',
      message: err.message,
    });
  }
}

export async function deleteWebhookHandler(req: Request, res: Response): Promise<any> {
  const { wyiUserId, webhookId } = req.body;

  if (!wyiUserId || !webhookId) {
    return res.status(400).json({
      success: false,
      error: 'missing_fields',
      message: 'wyiUserId and webhookId are required',
    });
  }

  try {
    const result = await db.collection('webhooks').deleteOne({
      _id: new ObjectId(webhookId),
      $or: [{ wyiUserId }, { linkedProviderIds: wyiUserId }],
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({
        success: false,
        error: 'not_found',
        message: 'Webhook not found or does not belong to this user.',
      });
    }

    return res.json({
      success: true,
      message: 'Webhook deleted.',
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: 'server_error',
      message: err.message,
    });
  }
}

export async function regenerateWebhookSecretHandler(req: Request, res: Response): Promise<any> {
  const { wyiUserId, webhookId } = req.body;

  if (!wyiUserId || !webhookId) {
    return res.status(400).json({
      success: false,
      error: 'missing_fields',
      message: 'wyiUserId and webhookId are required',
    });
  }

  const newSecret = crypto.randomBytes(32).toString('hex');

  try {
    const result = await db.collection('webhooks').findOneAndUpdate(
      { _id: new ObjectId(webhookId), $or: [{ wyiUserId }, { linkedProviderIds: wyiUserId }] },
      { $set: { secret: newSecret } },
      { returnDocument: 'after' },
    );

    if (!result) {
      return res.status(404).json({
        success: false,
        error: 'not_found',
        message: 'Webhook not found or does not belong to this user.',
      });
    }

    return res.json({
      success: true,
      secret: newSecret,
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: 'server_error',
      message: err.message,
    });
  }
}

export async function getUserWebhooksHandler(req: Request, res: Response): Promise<any> {
  const { wyiUserId } = req.params;
  if (!wyiUserId) {
    return res.status(400).json({
      success: false,
      error: 'missing_fields',
      message: 'wyiUserId is required',
    });
  }

  try {
    const hooks = await db.collection('webhooks')
      .find({ $or: [{ wyiUserId }, { linkedProviderIds: wyiUserId }] })
      .project({ secret: 0 })
      .toArray();
    return res.json({ success: true, data: hooks });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: 'server_error',
      message: err.message,
    });
  }
}

export async function getWebhookByIdHandler(req: Request, res: Response): Promise<any> {
  const { wyiUserId, webhookId } = req.params;
  if (!wyiUserId || !webhookId) {
    return res.status(400).json({
      success: false,
      error: 'missing_fields',
      message: 'wyiUserId and webhookId are required',
    });
  }

  try {
    const hook = await db.collection('webhooks').findOne({
      _id: new ObjectId(webhookId),
      $or: [{ wyiUserId }, { linkedProviderIds: wyiUserId }],
    });

    if (!hook) {
      return res.status(404).json({
        success: false,
        error: 'not_found',
        message: 'Webhook not found or does not belong to this user.',
      });
    }

    return res.json({
      success: true,
      data: {
        id: hook._id,
        wyiUserId: hook.wyiUserId,
        inbox: hook.inbox,
        url: hook.url,
        secret: hook.secret,
        active: hook.active,
        failureCount: hook.failureCount,
        createdAt: hook.createdAt,
        disabledAt: hook.disabledAt,
        disabledReason: hook.disabledReason,
      },
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: 'server_error',
      message: err.message,
    });
  }
}

export async function getUserWebhookLogsHandler(req: Request, res: Response): Promise<any> {
  const { wyiUserId } = req.params;
  if (!wyiUserId) {
    return res.status(400).json({
      success: false,
      error: 'missing_fields',
      message: 'wyiUserId is required',
    });
  }

  try {
    const logs = await db.collection('webhook_logs')
      .find({ $or: [{ wyiUserId }, { linkedProviderIds: wyiUserId }] })
      .sort({ timestamp: -1 })
      .limit(100)
      .toArray();
       
    return res.json({ success: true, data: logs });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: 'server_error',
      message: err.message,
    });
  }
}
