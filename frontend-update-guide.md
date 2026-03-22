# Frontend Update Guide: Migrating to Identity-Aware Secure API

The Maildrop backend has transitioned from a simple static API key model to a **contextual, identity-aware security architecture**. This guide provides the exact specifications needed to update your Next.js (or any) frontend to remain compatible.

## 1. Core Security Requirements

Every internal API request must now be **cryptographically signed** and include **identity context** headers. Requests lacking these will be rejected with `403 Forbidden`.

### Required Headers Checklist
| Header | Description | Value |
|--------|-------------|-------|
| `x-internal-api-key` | Static shared secret | `process.env.INTERNAL_API_KEY` |
| `x-signature` | HMAC-SHA256 hash | `hash(timestamp.method.path.body)` |
| `x-timestamp` | Request time | `Date.now().toString()` |
| `x-nonce` | One-time token | `crypto.randomUUID()` |
| `x-fp` | Device Fingerprint | `hash(IP + UA + TZ + Lang)` |
| `x-cookie-id` | Persistent ID | A UUID stored in a long-lived cookie (`fp_id`) |
| `x-user-id` | Authenticated User | The logged-in user's `wyiUserId` (if available) |

---

## 2. Implementation Guide

### Step A: Generate Persistent Cookie ID
On the frontend (e.g., in a middleware or root layout), ensure a persistent cookie named `fp_id` exists. This is crucial for the **Abuse Engine** to distinguish legitimate users from bot farms.

```typescript
// Example: Generating a unique ID if not present
if (!getCookie('fp_id')) {
  setCookie('fp_id', crypto.randomUUID(), { maxAge: 60 * 60 * 24 * 365 });
}
```

### Step B: The Central Signing Utility
Create a utility function to call the internal API. **Do not perform signing on the client-side** (to avoid leaking `INTERNAL_API_SECRET`). Use Next.js Server Actions or API Routes.

```typescript
import crypto from 'crypto';

/**
 * Signs and executes a request to the Maildrop Internal API.
 */
export async function callMaildropInternal(path: string, method: 'GET' | 'POST' | 'DELETE', body?: any) {
  const timestamp = Date.now().toString();
  const nonce = crypto.randomUUID();
  const bodyStr = body ? JSON.stringify(body) : '';
  
  // 1. Calculate HMAC Signature
  // Format: timestamp.METHOD.path.body
  const payload = `${timestamp}.${method}.${path}.${bodyStr}`;
  const signature = crypto.createHmac('sha256', process.env.INTERNAL_API_SECRET!)
    .update(payload)
    .digest('hex');

  // 2. Prepare Identity Context (Derived from incoming request)
  const fp = generateFingerprint(incomingReq); // SHA256 of IP, UA, etc.
  const cookieId = getCookie('fp_id');

  // 3. Execute Request via API Gateway
  const response = await fetch(`${process.env.INTERNAL_API_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-internal-api-key': process.env.INTERNAL_API_KEY!,
      'x-signature': signature,
      'x-timestamp': timestamp,
      'x-nonce': nonce,
      'x-fp': fp,
      'x-cookie-id': cookieId,
      'x-user-id': currentUser?.id || '',
    },
    body: method !== 'GET' ? bodyStr : undefined,
  });

  return response.json();
}
```

---

## 3. Handling Progressive Friction

The backend no longer "hard bans" spiky traffic from Free users. Instead, it injects **Progressive Friction** (artificial latency).

*   **Behavior**: Responses may take **200ms–1500ms** longer than usual.
*   **UX Action**: Ensure your frontend has high-quality loading skeletons or progress bars.
*   **Timeouts**: Increase your fetch timeout to at least **5 seconds** to account for friction delays.
*   **Trigger**: If a user hits a `429 Too Many Requests`, immediately show the **Upgrade Modal**:
    > "You're hitting Free tier limits. Upgrade to Developer plan for instant, high-speed API access."

---

## 4. Key Migration Points

1.  **Check URLs**: Ensure you are calling endpoints through the **API Gateway** (usually port 3000/8080) and not directly to individual backend nodes.
2.  **Idempotency**: For critical actions (like creating an inbox), you can optionally pass an `x-idempotency-key`. The backend will cache the response for 24 hours, making retries safe even if the network fails.
3.  **Plan Logic**: Stop relying on local storage for plan state. Use `GET /v1/me` (Public) or check the `x-derived-plan` header in internal responses to ensure the UI matches the server's enforced reality.

---
**Warning**: If you leak the `INTERNAL_API_SECRET` to the client-side bundle, the signature system becomes useless. **Always sign requests in your server-side environment.**
