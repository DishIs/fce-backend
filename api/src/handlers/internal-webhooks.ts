// api/src/handlers/internal-webhooks.ts
import { Request, Response } from 'express';
import { db } from '../config/mongo';
import { ObjectId } from 'mongodb';

export async function getUserWebhooksHandler(req: Request, res: Response): Promise<any> {
  const { wyiUserId } = req.params;
  if (!wyiUserId) return res.status(400).json({ success: false, message: 'wyiUserId is required' });

  try {
    const hooks = await db.collection('webhooks').find({ wyiUserId }).toArray();
    return res.json({ success: true, data: hooks });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function getUserWebhookLogsHandler(req: Request, res: Response): Promise<any> {
  const { wyiUserId } = req.params;
  if (!wyiUserId) return res.status(400).json({ success: false, message: 'wyiUserId is required' });

  try {
    const logs = await db.collection('webhook_logs')
      .find({ wyiUserId })
      .sort({ timestamp: -1 })
      .limit(100)
      .toArray();
      
    return res.json({ success: true, data: logs });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
