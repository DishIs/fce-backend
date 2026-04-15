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
*   **Body**: 
    ```json
    { 
      "inbox": "address@domain.com",
      "isTesting": true // (Optional) Flags inbox for diagnostic Timeline and Insight events (Growth/Enterprise only)
    }
    ```
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
Automatically extract the latest verification code and magic link from the most recent message. Includes probability scoring.

*   **Response (200 OK)**:
    ```json
    {
      "success": true,
      "otp": "847291",
      "score": 0.8,
      "email_id": "msg_abc123",
      "timestamp": 1713184200000,
      "verification_link": "https://auth.example.com/magic?token=xyz"
    }
    ```

### `POST /v1/inboxes/:address/tests`
Start a new test timeline. Associates future events with a specific test run. (Growth/Enterprise only).
*   **Body**: 
    ```json
    { "test_id": "tr_test_123" } // (Optional) Custom test identifier
    ```
*   **Response (200 OK)**:
    ```json
    { "success": true, "message": "Test started.", "test_id": "tr_test_123" }
    ```

### `GET /v1/inboxes/:address/timeline`
Fetch zero-latency delivery and processing events for diagnostic purposes. (Growth/Enterprise only).
*   **Query Parameters**: `?test_id=tr_test_123` (Optional)
*   **Response (200 OK)**:
    ```json
    {
      "success": true,
      "data": [
        {
          "id": "evt_1",
          "inbox": "test@domain.com",
          "type": "smtp_rcpt_received",
          "timestamp": 1713184200000,
          "latency_ms": 0,
          "test_run_id": "tr_test_123"
        }
      ]
    }
    ```

### `GET /v1/inboxes/:address/insights`
Fetch automated diagnostic issues regarding delivery and OTP parsing logic. (Growth/Enterprise only).
*   **Response (200 OK)**:
    ```json
    {
      "success": true,
      "data": [
        {
          "type": "slow_delivery",
          "message": "Delivery and processing took over 3s"
        }
      ]
    }
    ```
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
*   **Plan Requirement**: **Growth** or above.

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

### Timeline and Insights (New)

The observability API provides a granular timeline of events for a specific inbox, useful for debugging email flows and OTP extraction.

#### Get Inbox Timeline
`GET /v1/inboxes/{inbox}/timeline`

Returns an array of events:
```json
{
  "data": [
    {
      "id": "abc1234",
      "inbox": "test@ditmail.info",
      "type": "email_received",
      "timestamp": 1713175400000,
      "latency_ms": 0
    },
    {
      "id": "def5678",
      "inbox": "test@ditmail.info",
      "type": "otp_extracted",
      "timestamp": 1713175400820,
      "latency_ms": 820,
      "metadata": {
        "otp": "123456"
      }
    }
  ]
}
```

#### Get Inbox Insights
`GET /v1/inboxes/{inbox}/insights`

Returns a list of detected failures or warnings for an inbox. Requires Growth plan or higher.
```json
{
  "data": [
    {
      "type": "slow_delivery",
      "message": "Delivery and processing took over 3s"
    }
  ]
}
```
