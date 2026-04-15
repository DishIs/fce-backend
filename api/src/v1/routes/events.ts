import { Router } from 'express';
import { getTimeline, getInsights } from '../../services/events-service';

export const eventsRouter = Router();

eventsRouter.get('/:inbox/timeline', async (req, res) => {
  try {
    const { inbox } = req.params;
    const timeline = await getTimeline(inbox);
    res.json(timeline);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

eventsRouter.get('/:inbox/insights', async (req, res) => {
  try {
    const { inbox } = req.params;
    const insights = await getInsights(inbox);
    res.json(insights);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});
