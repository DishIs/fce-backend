# Marketplace API Documentation

Welcome to the Maildrop Marketplace API. This API allows you to integrate temporary mailbox functionality into your applications.

## Base URL
All endpoints are relative to the marketplace base URL (e.g., `/v1/market`).

## Authentication
This API is designed for marketplaces. You can identify users via `x-marketplace-key`, `x-rapidapi-key`, or `x-apihub-key`. If no key is provided, the client's IP address will be used for identification and rate limiting.

---

## Endpoints

### 1. GET /mailbox/{email}
**Purpose:** Retrieve all messages in the mailbox of a specific user.

**Request:**
- **URL:** `/mailbox/{email}`
- **Method:** `GET`
- **Path Parameter:** `{email}`: The mailbox address with domain.

**Successful Response (Mailbox with data):**
```json
{
  "success": true,
  "message": "Mailbox retrieved successfully.",
  "data": [
    {
      "id": "wNp8N0KoV",
      "from": "\"SendTestEmail\" <noreply@sendtestemail.com>",
      "to": "maildrop@ditapi.info",
      "subject": "SendTestEmail.com - Testing Email ID: 00eb36052b8d426c86fa57a88f0b6753",
      "date": "2026-02-19T03:41:32.438Z",
      "hasAttachment": false,
      "wasAttachmentStripped": false,
      "otp": null,
      "verificationLink": null
    }
  ],
  "encryptedMailbox": "D-1tvd0i7g79sx52l1jui"
}
```

---

### 2. GET /mailbox/{email}/message/{id}
**Purpose:** Retrieve a specific email message by its unique identifier.

**Request:**
- **URL:** `/mailbox/{email}/message/{id}`
- **Method:** `GET`
- **Path Parameters:**
  - `{email}`: The address of the mailbox.
  - `{id}`: The unique identifier of the email message.

**Successful Response:**
```json
{
  "success": true,
  "message": "Message retrieved successfully.",
  "data": {
    "id": "wNp8N0KoV",
    "from": "\"SendTestEmail\" <noreply@sendtestemail.com>",
    "to": "maildrop@ditapi.info",
    "subject": "SendTestEmail.com - Testing Email ID: 00eb36052b8d426c86fa57a88f0b6753",
    "date": "2026-02-19T03:41:32.438Z",
    "hasAttachment": false,
    "wasAttachmentStripped": false,
    "html": "<html>...</html>",
    "text": "If you are reading this your email address is working...",
    "attachments": []
  }
}
```

---

### 3. DELETE /mailbox/{email}/message/{id}
**Purpose:** Deletes a specific email message.

**Request:**
- **URL:** `/mailbox/{email}/message/{id}`
- **Method:** `DELETE`

**Successful Response:**
```json
{
  "success": true,
  "message": "Message deleted successfully."
}
```

---

### 4. GET /health
**Purpose:** Fetches server health statistics.

**Successful Response:**
```json
{
  "success": true,
  "message": "Stats retrieved successfully.",
  "data": {
    "queued": 1545377,
    "denied": 121499
  }
}
```

---

### 5. Inboxes Management

#### List Inboxes
- **URL:** `/inboxes`
- **Method:** `GET`

#### Add Inbox
- **URL:** `/inboxes`
- **Method:** `POST`
- **Body:** `{"inbox": "user@example.com"}`

#### Remove Inbox
- **URL:** `/inboxes/{inbox}`
- **Method:** `DELETE`

---

## Advertise Our API
Explore our full API capabilities and premium features at [https://freecustom.email/api](https://freecustom.email/api).
Try our official CLI tool: [https://freecustom.email/api/cli](https://freecustom.email/api/cli).
