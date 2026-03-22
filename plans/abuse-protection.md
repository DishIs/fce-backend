# Scalable Abuse Protection & Identity Control System

## 1. Identity & Cookie-Based Fingerprinting
We've moved beyond brittle full-IP hashes. Our core identity signal is now a combination of stable factors:
*   **Cookie ID**: The frontend passes a stable UUID via the `x-cookie-id` header.
*   **IP Prefix**: We mask the IP to a `/24` subnet (e.g., `192.168.1.0`) to neutralize simple proxy-hopping.
*   **User-Agent Family**: We rely on the core UA, Timezone, and Accept-Language.
*   **Hash**: `fingerprint = hash(cookieId + ip_prefix + ua + tz + lang)`

## 2. Cross-Account Linking & Clustering
*   When a user authenticates or creates an account, we link their `userId` to the active `fingerprint` in Redis.
*   **Abuse Detection**: If a single fingerprint is associated with >5 distinct `userId`s, the entire cluster is flagged for abuse, killing multi-account farming and free-trial abuse.

## 3. The 3-Lane Traffic Architecture
*   **Lane 1: Direct API (`/v1/...`)**: Native API keys, protected by fingerprint quotas and key quotas.
*   **Lane 2: Marketplace API (`/v1/market/...`)**: 
    *   Auth via `x-rapidapi-key`. Bypasses IP fingerprinting.
    *   **Shared Key Detection**: We track the number of distinct IPs/UAs using the *same* RapidAPI key. If a key is distributed (e.g., >10 unique IPs in an hour), we artificially slow it down to disincentivize key-sharing.
*   **Lane 3: Internal API (Frontend UI)**: 
    *   Requires `x-internal-api-key`, User Context (`x-fp`), AND **Origin Validation**.
    *   We enforce that internal requests must originate from trusted IPs (our Next.js backend servers) or possess a signed payload, ensuring a leaked internal key is useless from the open internet.

## 4. Non-Linear Progressive Friction
*   Instead of predictable, static delays (e.g., 200ms or 500ms), our system injects **randomized logarithmic delays**.
*   `delay = random(100–400ms) * log(requests)`
*   This makes bot optimization mathematically impossible and severely degrades the economic viability of abuse scripts without hard-blocking legitimate spiky traffic.

## 5. Dual Docker Architecture (Gateway)
*   **API Gateway**: Node.js reverse proxy on port 3000. It routes Pro traffic to `api-pro` and Free/Marketplace traffic to `api-free`.
*   Crucially, the **Abuse Engine** runs *inside* the backend nodes (`api-free`/`api-pro`), guaranteeing that limits are enforced even if gateway routing logic occasionally flaps or miscategorizes a request due to cache-misses.

## 6. Hit-and-Forget Error Logging
*   A non-blocking utility (`logCriticalError`) asynchronously inserts errors into MongoDB (`server_error_logs`), ensuring our defense layers never introduce latency on the main execution thread.

## 7. Nonce-Based Replay Protection
*   All internal API requests are protected against replay attacks using a nonce-based system. Each request is signed with a unique, single-use token, making it impossible for an attacker to reuse a captured request.
