// api/src/handlers/auto-billing-handler.ts
import { Request, Response } from 'express';
import { db } from '../config/mongo';
import { API_PLANS, ApiPlanName } from '../v1/api-plans';

function getPaddlePriceId(plan: ApiPlanName, interval: 'monthly' | 'yearly' = 'monthly'): string | null {
  const map: Partial<Record<ApiPlanName, any>> = {
    developer: { monthly: process.env.PADDLE_PRICE_DEVELOPER, yearly: process.env.PADDLE_PRICE_DEVELOPER_YEARLY },
    startup:   { monthly: process.env.PADDLE_PRICE_STARTUP,   yearly: process.env.PADDLE_PRICE_STARTUP_YEARLY },
    growth:    { monthly: process.env.PADDLE_PRICE_GROWTH,    yearly: process.env.PADDLE_PRICE_GROWTH_YEARLY },
    enterprise:{ monthly: process.env.PADDLE_PRICE_ENTERPRISE,yearly: process.env.PADDLE_PRICE_ENTERPRISE_YEARLY },
  };
  return map[plan]?.[interval] ?? null;
}

const PADDLE_BASE = process.env.PADDLE_ENV === 'sandbox' ? 'https://sandbox-api.paddle.com' : 'https://api.paddle.com';

function paddleHeaders() {
  return {
    Authorization: `Bearer ${process.env.PADDLE_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

export async function autoChargeApiPlanHandler(req: Request, res: Response): Promise<any> {
  const { userId, targetPlan, interval = 'monthly' } = req.body;
  if (!userId || !targetPlan || !API_PLANS[targetPlan as ApiPlanName]) {
    return res.status(400).json({ success: false, message: 'Invalid payload' });
  }

  const priceId = getPaddlePriceId(targetPlan as ApiPlanName, interval);
  if (!priceId) return res.status(400).json({ success: false, message: 'Plan price ID not configured' });

  const user = await db.collection('users').findOne({ wyiUserId: userId });
  if (!user || !user.paddleCustomerId) {
    return res.status(400).json({ success: false, error: 'no_customer', message: 'No Paddle Customer ID found. Manual checkout required.' });
  }

  // If already has an API subscription, they should use the change-plan endpoint
  if (user.paddleApiSubscriptionId) {
    return res.status(400).json({ success: false, error: 'existing_subscription', message: 'User already has an API subscription.' });
  }

  try {
    // Attempt to create a subscription with automatic collection using saved payment methods
    const body = {
      customer_id: user.paddleCustomerId,
      items: [{ price_id: priceId, quantity: 1 }],
      collection_mode: 'automatic',
      custom_data: { isApi: 'true', userId: user.wyiUserId, plan: targetPlan }
    };

    const paddleRes = await fetch(`${PADDLE_BASE}/subscriptions`, {
      method: 'POST',
      headers: paddleHeaders(),
      body: JSON.stringify(body)
    });
    
    const json = await paddleRes.json();
    if (!paddleRes.ok) {
      // Return specific error for frontend to trigger checkout
      return res.status(400).json({ 
        success: false, 
        error: 'paddle_error', 
        code: json?.error?.code,
        message: json?.error?.detail || 'Payment method not saved or failed.' 
      });
    }

    // Success! The subscription is created and charged automatically
    const subId = json.data.id;
    await db.collection('users').updateOne(
      { wyiUserId: userId },
      { $set: { apiPlan: targetPlan, paddleApiSubscriptionId: subId } }
    );

    return res.json({ success: true, message: `Successfully upgraded to ${targetPlan} plan.` });

  } catch (err: any) {
    return res.status(500).json({ success: false, error: 'server_error', message: err.message });
  }
}

export async function autoChargeCreditsHandler(req: Request, res: Response): Promise<any> {
  const { userId, priceId } = req.body;
  if (!userId || !priceId) return res.status(400).json({ success: false, message: 'userId and priceId required' });

  const user = await db.collection('users').findOne({ wyiUserId: userId });
  if (!user || !user.paddleCustomerId) {
    return res.status(400).json({ success: false, error: 'no_customer', message: 'Manual checkout required.' });
  }

  try {
    // Create a one-off transaction
    const body = {
      customer_id: user.paddleCustomerId,
      items: [{ price_id: priceId, quantity: 1 }],
      collection_mode: 'automatic',
      custom_data: { isCredits: 'true', userId: user.wyiUserId }
    };

    const paddleRes = await fetch(`${PADDLE_BASE}/transactions`, {
      method: 'POST',
      headers: paddleHeaders(),
      body: JSON.stringify(body)
    });
    
    const json = await paddleRes.json();
    if (!paddleRes.ok) {
      return res.status(400).json({ 
        success: false, 
        error: 'paddle_error', 
        code: json?.error?.code,
        message: json?.error?.detail || 'Charge failed. Manual checkout required.' 
      });
    }

    // Transaction created, but Paddle might process it async. Usually automatic collection creates it in 'completed' or 'ready' state.
    // The webhook handler will grant credits when payment is complete.
    return res.json({ success: true, message: 'Credit purchase initiated successfully.', transaction_id: json.data.id });

  } catch (err: any) {
    return res.status(500).json({ success: false, error: 'server_error', message: err.message });
  }
}
