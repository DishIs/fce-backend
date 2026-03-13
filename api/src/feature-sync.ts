// api/src/feature-sync.ts
import { API_PLANS, WS_PLANS } from './v1/api-plans';
import { resolveEffectivePlan } from './v1/resolve-plan';

/**
 * Synchronizes user feature limits (Webhooks, WebSockets) with their current plan.
 * Safely disables/restores integrations when upgrading or downgrading.
 */
export async function syncUserFeatures(db: any, redis: any, userId: string) {
  // 1. Fetch fresh user data
  const user = await db.collection('users').findOne({
    $or: [{ wyiUserId: userId }, { linkedProviderIds: userId }]
  });
  
  if (!user) return;

  const effectivePlan = resolveEffectivePlan(user);
  const supportsWebhooks = WS_PLANS.includes(effectivePlan);

  // 2. Sync Webhooks (Make.com / Zapier / REST-hooks)
  if (!supportsWebhooks) {
    // Disable active webhooks and tag them so we know WHY they were disabled
    const result = await db.collection('webhooks').updateMany(
      { wyiUserId: user.wyiUserId, active: true },
      { $set: { active: false, disabledAt: new Date(), disabledReason: 'plan_downgrade' } }
    );
    if (result.modifiedCount > 0) {
      console.log(`[feature-sync] Disabled ${result.modifiedCount} webhooks for ${user.wyiUserId} (Plan: ${effectivePlan})`);
    }
  } else {
    // Restore webhooks that were disabled *specifically* due to a previous downgrade.
    // (Ignores webhooks disabled due to 'too_many_failures' from webhooks.ts)
    const result = await db.collection('webhooks').updateMany(
      { wyiUserId: user.wyiUserId, active: false, disabledReason: 'plan_downgrade' },
      { $set: { active: true }, $unset: { disabledAt: "", disabledReason: "" } }
    );
    if (result.modifiedCount > 0) {
      console.log(`[feature-sync] Restored ${result.modifiedCount} webhooks for ${user.wyiUserId} (Plan: ${effectivePlan})`);
    }
  }

  // 3. Sync WebSockets limits (Real-time Push)
  const config = API_PLANS[effectivePlan];
  if (config && redis) {
    try {
      // Broadcast the new limits. Your separate WebSocket server should listen to 
      // 'api_plan_changed' and force-close connections exceeding maxWsConnections,
      // or close all connections if websocketEnabled is false.
      await redis.publish('api_plan_changed', JSON.stringify({
        userId: user.wyiUserId,
        plan: effectivePlan,
        maxWsConnections: config.features.maxWsConnections,
        websocketEnabled: config.features.websocket
      }));
    } catch (err) {
      console.error('[feature-sync] Redis publish failed:', err);
    }
  }
}