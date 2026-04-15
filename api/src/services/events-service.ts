import { redisClient, redisPubSub } from '../config/redis';

export type EmailEvent = {
  id: string;
  inbox: string;
  type:
    | "inbox_created"
    | "email_received"
    | "email_parsed"
    | "otp_extracted"
    | "webhook_sent"
    | "websocket_sent"
    | "error";
  timestamp: number;
  latency_ms?: number;
  metadata?: any;
  test_run_id?: string;
};

export async function logEvent(event: Omit<EmailEvent, "id" | "timestamp">) {
  try {
    const fullEvent: EmailEvent = {
      ...event,
      id: Math.random().toString(36).substring(7),
      timestamp: Date.now()
    };
    
    const key = `events:${event.inbox}`;
    await redisClient.zadd(key, fullEvent.timestamp, JSON.stringify(fullEvent));
    // 24 hours TTL for free, can be extended based on plan
    await redisClient.expire(key, 86400);
    
    if (redisPubSub) {
      await redisPubSub.publish(`mailbox:events:${event.inbox}`, JSON.stringify({
        type: 'event_update',
        payload: fullEvent
      })).catch(() => {});
    }
    
    return fullEvent;
  } catch (err) {
    console.error('Failed to log event', err);
  }
}

export async function getTimeline(inbox: string): Promise<EmailEvent[]> {
  try {
    const key = `events:${inbox}`;
    const eventsStr = await redisClient.zrange(key, 0, -1);
    
    if (!eventsStr || eventsStr.length === 0) return [];
    
    let events: EmailEvent[] = eventsStr.map((e: string) => JSON.parse(e));
    
    // Sort and calculate latency relative to first event
    events = events.sort((a, b) => a.timestamp - b.timestamp);
    if (events.length > 0) {
        const startTime = events[0].timestamp;
        events.forEach(e => {
            if (e.timestamp >= startTime) {
                 e.latency_ms = e.timestamp - startTime;
            }
        });
    }
    
    return events;
  } catch (err) {
    console.error('Failed to get timeline', err);
    return [];
  }
}

export async function getInsights(inbox: string) {
    const events = await getTimeline(inbox);
    const insights = [];
    
    const emailReceived = events.filter(e => e.type === 'email_received');
    if (emailReceived.length === 0) {
        const firstEvent = events[0];
        if (firstEvent && (Date.now() - firstEvent.timestamp > 5000)) {
             insights.push({ type: 'email_missing', message: 'Email not received within 5s' });
        }
    } else if (emailReceived.length > 1) {
        insights.push({ type: 'multiple_detected', message: 'Multiple emails detected' });
    }
    
    const otpExtracted = events.find(e => e.type === 'otp_extracted');
    if (emailReceived.length > 0 && !otpExtracted) {
        insights.push({ type: 'otp_failed', message: 'OTP parsing failed or no OTP found' });
    }
    
    const lastEvent = events[events.length - 1];
    if (lastEvent && lastEvent.latency_ms && lastEvent.latency_ms > 3000) {
        insights.push({ type: 'slow_delivery', message: 'Delivery and processing took over 3s' });
    }
    
    return insights;
}
