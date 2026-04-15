import { Request, Response } from 'express';
import { getTimeline, getInsights } from '../services/events-service';

export async function getUserTimelineHandler(req: Request, res: Response) {
  try {
    const { inbox } = req.query;
    if (!inbox || typeof inbox !== 'string') {
      return res.status(400).json({ success: false, message: 'inbox is required' });
    }
    const timeline = await getTimeline(inbox);
    res.json({ success: true, data: timeline });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
}

export async function getUserInsightsHandler(req: Request, res: Response) {
  try {
    const { inbox } = req.query;
    if (!inbox || typeof inbox !== 'string') {
      return res.status(400).json({ success: false, message: 'inbox is required' });
    }
    const insights = await getInsights(inbox);
    res.json({ success: true, data: insights });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
}
