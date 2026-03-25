// api/src/utils/paddle-api.ts
// ─────────────────────────────────────────────────────────────────────────────
//  Thin wrapper around the Paddle v2 REST API.
//  Used for server-side subscription management (cancel, verify).
//
//  Required env vars:
//    PADDLE_API_KEY   — secret key from Paddle dashboard (Developers → API keys)
//    PADDLE_ENV       — "sandbox" | "production"  (defaults to "production")
// ─────────────────────────────────────────────────────────────────────────────

const PADDLE_BASE =
  process.env.PADDLE_ENV === 'sandbox'
    ? 'https://sandbox-api.paddle.com'
    : 'https://api.paddle.com';

function paddleHeaders(): HeadersInit {
  const apiKey = process.env.PADDLE_API_KEY;
  if (!apiKey) throw new Error('PADDLE_API_KEY env var is not set');
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
}

// ── Cancel a subscription immediately ────────────────────────────────────────

export async function cancelPaddleSubscription(subscriptionId: string): Promise<void> {
  const url = `${PADDLE_BASE}/subscriptions/${subscriptionId}/cancel`;
  const res = await fetch(url, {
    method:  'POST',
    headers: paddleHeaders(),
    body:    JSON.stringify({ effective_from: 'immediately' }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `[paddle-api] cancelSubscription(${subscriptionId}) failed ${res.status}: ${body}`,
    );
  }
}

// ── Fetch subscription details ────────────────────────────────────────────────

export interface PaddleSubscriptionDetails {
  id:              string;
  status:          string;
  customerId:      string;
  scheduledChange: any;
  paymentMethodDetails?: {
    card?: {
      last_four:     string;
      expiry_month:  number;
      expiry_year:   number;
      type:          string;
    };
  };
}

export async function getPaddleSubscription(
  subscriptionId: string,
): Promise<PaddleSubscriptionDetails | null> {
  const url = `${PADDLE_BASE}/subscriptions/${subscriptionId}`;
  const res = await fetch(url, { headers: paddleHeaders() });

  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `[paddle-api] getSubscription(${subscriptionId}) failed ${res.status}: ${body}`,
    );
  }

  const json = await res.json();
  return json?.data ?? null;
}