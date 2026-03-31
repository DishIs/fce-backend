# Public Developer API Documentation

Welcome to the Maildrop Public Developer API. This API allows you to programmatically manage inboxes, retrieve messages, and configure custom domains.

## 1. Authentication

All requests to the `/v1` endpoints require an API Key. You can provide your API key in two ways:

1.  **Bearer Token (Recommended)**:
    ```http
    Authorization: Bearer YOUR_API_KEY
    ```
2.  **Query Parameter**:
    ```http
    GET /v1/inboxes?api_key=YOUR_API_KEY
    ```

## 2. Base URL

```text
https://api.freecustom.email/v1
```

## 3. Account & Identity

### `GET /v1/me`
Retrieve information about the current API user and plan.
*   **Response (200 OK)**:
    ```json
    {
      "success": true,
      "data": {
        "plan": "growth",
        "plan_label": "Growth Tier",
        "credits": 500,
        "rate_limits": { "requestsPerSecond": 50, "requestsPerMonth": 2000000 },
        "features": { "otpExtraction": true, "websocket": true, "customDomains": true }
      }
    }
    ```

### `GET /v1/usage`
Check your current monthly usage against your plan limits.

---

## 4. Inbox Management

### `GET /v1/inboxes`
List all inboxes registered under your account.
*   **Response (200 OK)**:
    ```json
    {
      "success": true,
      "data": [
        { "inbox": "mybox@ditube.info", "local": "mybox", "domain": "ditube.info" }
      ],
      "count": 1
    }
    ```

### `POST /v1/inboxes`
Register a new temporary inbox.
*   **Body**: `{ "inbox": "address@domain.com" }`
*   **Response (201 Created)**:
    ```json
    { "success": true, "message": "Inbox registered." }
    ```

### `DELETE /v1/inboxes/:address`
Delete an inbox and all its messages.

---

## 5. Message Retrieval

### `GET /v1/inboxes/:address/messages`
Retrieve all messages for a specific inbox.
*   **Response (200 OK)**:
    ```json
    {
      "success": true,
      "data": [
        { "id": "msg_123", "subject": "Welcome", "from": "no-reply@service.com", "createdAt": "2024-03-21..." }
      ]
    }
    ```

### `GET /v1/inboxes/:address/messages/:id`
Retrieve the full content of a specific message.

### `DELETE /v1/inboxes/:address/messages/:id`
Permanently delete a specific message.

---

## 6. Premium Features

### `GET /v1/inboxes/:address/otp`
Automatically extract the latest 4-6 digit code from the most recent message.
*   **Plan Requirement**: **Growth** or above.

### `GET /v1/inboxes/:address/wait`
Wait for a new email to arrive in the specified mailbox (Long Polling). This eliminates the need for rapid polling and reduces request overhead.
*   **Query Params**:
    *   `timeout`: Max seconds to wait (10–60 recommended, default 30).
    *   `since`: (Optional) Last seen message ID. Return immediately if a newer message exists, otherwise wait.
*   **Plan Requirement**: **Developer** or above.
*   **Billing**: High-value endpoint; 1 wait call consumes **10 monthly requests**.
*   **Response (Success)**:
    ```json
    {
      "success": true,
      "message": "New message received",
      "data": { "id": "wNp8N0KoV", "subject": "Your OTP", ... }
    }
    ```
*   **Response (Timeout)**:
    ```json
    { "success": false, "message": "Timeout reached" }
    ```

### `GET /v1/custom-domains`
List your active custom domains.
*   **Plan Requirement**: **Growth** or above.

### `POST /v1/webhooks`
Subscribe to real-time message notifications via webhook.
*   **Body**: `{ "url": "https://your-server.com/callback", "inbox": "target@domain.com" }`
*   **Plan Requirement**: **Startup** or above.

---

## 7. Error Codes & Troubleshooting

| Error Code | Status | Description |
|------------|--------|-------------|
| `invalid_api_key` | 401 | The provided API key is invalid or revoked. |
| `missing_field` | 400 | A required field (like `inbox`) is missing from the request body. |
| `rate_limit_exceeded` | 429 | You have exceeded your plan's rate limit. |
| `too_many_requests` | 429 | Suspicious behavior detected (e.g. multi-account farming). |
| `plan_required` | 403 | This feature requires a higher tier subscription. |
| `forbidden` | 403 | You do not have permission for this resource. |

## 8. Rate Limits & Abuse Engine

We enforce dynamic stability via our **Abuse Engine**:
1.  **Rate Limiting**: Tiered RPS (Requests Per Second) based on your plan.
2.  **Progressive Friction**: Free tier users subjected to rapid polling may experience artificial randomized delays (100ms–500ms).
3.  **Fingerprinting**: Requests are grouped by a persistent identity layer to prevent bot farm abuse.

---
Need more scale? [Upgrade your plan](https://freecustom.email/pricing).
