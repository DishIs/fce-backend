[Live Site](https://freecustom.email)
[Buy API](https://rapidapi.com/dishis-technologies-maildrop/api/temp-mail-maildrop1)
# Advanced Server API Documentation
This document provides detailed information on your mail server's API endpoints, expected responses, and encryption methodologies. The API is designed for efficient mailbox management, including retrieving messages, checking server health, and handling encrypted mailbox identifiers.

**Send Mail on: {name}@kodewith.me**

## 1. GET /mailbox/{name}
**Purpose:**

Retrieve all messages in the mailbox of a specific user.

**Request:**
- URL: `/mailbox/{name}`
- Method: GET
- Path Parameter:
- `{name}`: The mailbox name, usually a username or alias.

**Headers:**
- *Content-Type: application/json*
Optional Authentication Token (if using a secured server).
### Successful Response (Mailbox with data):
```json
{
  "success": true,
  "message": "Mailbox retrieved successfully.",
  "data": [
    {
      "id": "h7YSqaxFz",
      "from": "\"Dishant Singh\"",
      "to": "dishant",
      "subject": "asdf",
      "date": "2024-09-25T13:02:57.289Z"
    },
    {
      "id": "ZNOOuid_0",
      "from": "\"Dishant Singh\"",
      "to": "dishant",
      "subject": "sdf",
      "date": "2024-09-25T12:45:17.006Z"
    },
    {
      "id": "oxsToRzJX",
      "from": "\"Dishant Singh\"",
      "to": "dishant",
      "subject": "hello man",
      "date": "2024-09-25T10:15:26.248Z"
    }
  ],
  "encryptedMailbox": "D-1qdvjaze"
}
```
### Successful Response (Empty Mailbox):
```json
{
  "success": true,
  "message": "Mailbox retrieved successfully.",
  "data": [],
  "encryptedMailbox": "D-n4ycz"
}
```
**Explanation:**
- `data`: Contains an array of messages if present. Each message object includes the following fields:
- `id`: A unique identifier for the message.
- `from`: The sender of the message.
- `to`: The recipient (the mailbox user).
- `subject`: The subject line of the email.
- `date`: The timestamp when the email was received (in ISO 8601 format).
- `encryptedMailbox`: A unique, encrypted identifier for the mailbox, used for security purposes.

## 2. GET /mailbox/{name}/message/{id}
**Purpose:**

Retrieve a specific email message from the user's mailbox by its unique identifier.

**Request:**
- URL: /mailbox/{name}/message/{id}
- Method: GET

**Path Parameters:**

- {name}: The name of the mailbox.
- {id}: The unique identifier of the email message.

**Headers:**

- *Content-Type: application/json*
Optional Authentication Token (if using a secured server).
### Successful Response (Message Found):
```json
{
  "success": true,
  "message": "Message retrieved successfully.",
  "data": {
    "id": "7122AUPOL",
    "from": "dishant@kodewith.me",
    "to": "rishika.singh",
    "subject": "Testing SMTP connectivity!",
    "date": "2024-09-25T06:10:24.271Z",
    "body": "Received: from yourdomain.com (Unknown [127.0.0.1])\r\n\tby kodewith.me (Haraka/3.0.4) with SMTP id 9D13742E-7083-46B1-901A-058F2EB12C1A.1\r\n\tenvelope-from ;\r\n\tWed, 25 Sep 2024 06:10:14 +0000\r\nFrom: dishant@kodewith.me\r\nTo: rishika.singh@dishis.tech\r\nSubject: Testing SMTP connectivity!\r\nX-Mailer: Febooti Automation Workshop\r\nContent-Type: text/plain; charset=UTF-8\r\nDate: Tue, 17 Mar 2020 17:13:54 +0200\r\nX-Priority: 3 (normal)\r\n\r\nSMTP connectivity test\r\n(with logging session details to text file).\r\n\r\n---\r\nEmail sent with trial version\r\nof Automation Workshop 8.1.0\r\nVisit febooti.com to get full version\r\n",
    "html": "<p>SMTP connectivity test<br>(with logging session details to text file).</p><hr><p>Email sent with trial version<br>of Automation Workshop 8.1.0<br>Visit febooti.com to get full version</p>"
  },
  "encryptedMailbox": "D-3670x23pe7gkt"
}
```
### Error Response (Message Not Found):
```json
{
  "success": false,
  "message": "Message not found.",
  "details": {
    "mailbox": "D-3670x23pe7gkt",
    "id": "7122AUPO"
  }
}
```
**Explanation:**
- `body`: The plain text version of the email.
- `html`: The HTML version of the email content.
- `from / to / subject / date`: Standard metadata for the email message.

## 3. DELETE /mailbox/{name}/message/{id}
**Purpose:**

Deletes a specific email message from the user's mailbox.

**Request:**
- URL: `/mailbox/{name}/message/{id}`
- Method: DELETE

**Path Parameters:**
- {name}: The name of the mailbox.
- {id}: The unique identifier of the email message.

**Headers:**
- *Content-Type: application/json*

Optional Authentication Token (if using a secured server).
### Successful Response (Message Deleted):
```json
{
  "success": true,
  "message": "Message deleted successfully."
}
```
**Explanation:**

This API deletes the specific email message from the mailbox. It doesn't return the message data after deletion, but you can verify that the message no longer exists by requesting the `/mailbox/{name}` endpoint.

## 4. GET /health
**Purpose:**
Fetches server health statistics, providing insight into the number of queued and denied requests.

**Request:**
- URL: /health
- Method: GET

**Headers:**
- *Content-Type: application/json*

### Successful Response:
```json
{
  "success": true,
  "message": "Stats retrieved successfully.",
  "data": {
    "queued": 6,
    "denied": 35
  }
}
```
**Explanation:**
- queued: The number of messages that are queued for processing.
- denied: The number of denied requests, such as emails blocked due to spam or other policies.

## 5. Mailbox Encryption Process
### Encryption Methodology:
To protect mailbox identifiers, the system uses a custom encryption process. Below is a detailed breakdown of how mailbox names are encrypted:

**Remove Non-Alphanumeric Characters:**

All special characters, spaces, and punctuation are stripped from the mailbox name.

**Convert the Cleaned String to a Long Integer:**

The alphanumeric characters are converted into a long integer, preserving the unique nature of the name.

**Reverse Digits and Prepend '1':**

The digits of the long integer are reversed to obfuscate the original sequence.
A '1' is prepended to this reversed string to ensure the final value meets a minimum length requirement.

**Add a Private Modifier:**

A special private modifier (e.g., appending an identifier to signify the private nature of the mailbox) is added for additional security. 
The private modifier is `20190422`

**Base36 Encoding:**

The modified integer is then encoded into base36 (a numeral system that uses 0–9 and A–Z), reducing its length and making it more compact.

**Prefix the Encrypted Value:**

The final encrypted value is prepended with a designated prefix (e.g., D- for distinguishing encrypted mailbox IDs).

### Example:
Original Mailbox: `dishant@mail.com`

**Encryption Steps:**

- Strip non-alphanumeric: `dishantmailcom`
- Convert to long integer: `12345678901234`
- Reverse and prepend: `143210987654321`
- Add private modifier: `143210987654321P`
- Convert to base36: `1qdvjaze`
- Prepend prefix: `D-1qdvjaze`
- Final Encrypted Mailbox: `D-1qdvjaze`

**Code for decoder:**
```js
import bigInt from 'big-integer';

const ALTINBOX_MOD = bigInt("20190422");

export function decryptMailbox(encryptedMailbox: string): string {
  // Remove the prefix
  const withoutPrefix = encryptedMailbox.slice(2); // Remove 'D-'
  
  // Convert from base36 to a number
  const decryptedNum = bigInt(withoutPrefix, 36);
  
  // Subtract the private modifier
  const adjustedNum = decryptedNum.subtract(ALTINBOX_MOD);
  
  // Convert back to string, remove the leading '1', and reverse it
  const reversedString = adjustedNum.toString().slice(1).split("").reverse().join("");
  
  // Convert back to original base 36 (only alphanumeric characters)
  const originalMailbox = reversedString.replace(/[^0-9a-z]/gi, '');

  return originalMailbox;
}

// Example usage:
const encrypted = encryptMailbox("dishantmailcom");
const decrypted = decryptMailbox(encrypted);
console.log(`Encrypted: ${encrypted}`);
console.log(`Decrypted: ${decrypted}`);
```

This process ensures that even if mailbox names are exposed, they are obfuscated and cannot be easily reverse-engineered.

## Security Considerations
### Authentication & Authorization:
All sensitive endpoints require an authentication token for security, especially when accessing or modifying mailbox data.

**Encryption:**
Mailbox identifiers are encrypted to prevent unauthorized access and tampering. All encryption algorithms follow industry best practices.

**Rate Limiting:**
The API applies rate limiting to prevent abuse, especially on endpoints such as mailbox deletion and message retrieval.
