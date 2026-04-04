import { sendEmail } from '../email/resend';
import { client as redis } from '../config/redis';

const ALERT_EMAIL = 'dishantsinghdev@icloud.com';

type AnomalyType = 'nonce_replay' | 'hmac_mismatch' | 'abuse_429' | 'user_warned' | 'user_banned';

/**
 * Tracks and alerts on system anomalies.
 * Uses Redis to rate-limit emails to avoid spamming the Free Resend tier.
 */
export async function notifyAnomaly(type: AnomalyType, details: string) {
  const hourKey = `alert_sent:${type}:${new Date().toISOString().slice(0, 13)}`;
  
  try {
    // 1. Increment a counter in Redis for this anomaly type
    const statsKey = `stats:anomaly:${type}:${new Date().toISOString().slice(0, 10)}`;
    await redis.incr(statsKey);
    await redis.expire(statsKey, 86400 * 7); // keep stats for 7 days

    // 2. Check if we've already sent an alert email for this type in the last hour
    const alreadySent = await redis.get(hourKey);
    if (alreadySent) return;

    // 3. Send the alert
    console.warn(`[ALERT] Sending anomaly email for ${type}`);
    await sendEmail({
      to: ALERT_EMAIL,
      subject: `🚨 Maildrop Anomaly: ${type.toUpperCase()}`,
      html: `
        <h2>System Anomaly Detected</h2>
        <p><strong>Type:</strong> ${type}</p>
        <p><strong>Time:</strong> ${new Date().toISOString()}</p>
        <p><strong>Context:</strong> ${details}</p>
        <hr/>
        <p>This alert is rate-limited to 1 per hour per type to protect your Resend quota.</p>
      `,
      from: 'api'
    });

    // 4. Mark as sent for this hour
    await redis.set(hourKey, '1', { EX: 3600 });
  } catch (err) {
    console.error('[notifyAnomaly] Failed:', err);
  }
}
