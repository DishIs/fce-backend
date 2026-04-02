# MCP Access (AI-Native Email Workflows)

Welcome to the **FreeCustom.Email Model Context Protocol (MCP)** documentation. 

Our MCP layer is not just another API client—it is a **premium interface** built specifically for AI agents, LLMs, and advanced automation systems. It wraps our backend architecture into intent-driven tools that AI agents can use out-of-the-box.

## Why MCP?

Traditional APIs require you to build logic: "create inbox", "poll for email", "parse text", "extract OTP".

With our MCP, you use **AI-native workflows**. You provide the intent, and the server handles the complexity.
*   **No Polling**: Powered by long-polling and Redis pub/sub.
*   **No Complex Logic**: Single operations handle multi-step flows (e.g., `create_and_wait_for_otp`).
*   **Agent-Ready**: Simply attach the server to Claude Desktop, Cursor, or your custom agent framework.

## Plan Requirements & Feature Gating

The MCP layer is a premium feature, restricted to our higher-tier plans:

| Plan | MCP Access | Ops per Minute | Concurrent Sessions |
| :--- | :--- | :--- | :--- |
| **Free** | ❌ Blocked | 0 | 0 |
| **Developer** | ❌ Blocked | 0 | 0 |
| **Startup** | ❌ Blocked | 0 | 0 |
| **Growth** | ✅ Included | 60 | 5 |
| **Enterprise** | ✅ Included | 200 | 10 |

*Note: If a restricted plan attempts to use the MCP endpoints, a specific upgrade hint (`{"error": "MCP not available on your plan", "upgrade": "Growth required"}`) is returned.*

## Advanced Pricing & Billing

Because MCP tools perform advanced processing (combining authentication, inbox creation, listening, and extracting), **MCP requests consume higher credits** than normal API operations.

This justifies the immense time-savings for AI developers:

| Operation | Action | Cost (Multiplier) |
| :--- | :--- | :--- |
| `get_latest_email` | Fetch the latest message from an inbox | **2x** normal API request |
| `extract_otp` | Parse and extract OTP from an inbox | **3x** normal API request |
| `create_and_wait_for_otp` | Create inbox & wait for OTP in one call | **5x** normal API request |

## Tools Provided

### 1. `get_latest_email`
Retrieves the most recent email for a given inbox address. 
*   **Args**: `inbox` (string)

### 2. `extract_otp`
Directly retrieves the latest 4-6 digit code or verification link.
*   **Args**: `inbox` (string)

### 3. `create_and_wait_for_otp` (🔥 GOLD FEATURE)
Generates a random inbox on our premium domains and holds the connection open until an OTP arrives. This allows an AI agent to execute a complete signup flow in a single tool call!
*   **Args**: `domain` (optional string), `timeout` (optional number 10-60)

## Installation & Setup

You can run our MCP server via `npx` or by installing it from source.

**Option 1: NPX (Recommended)**
Configure your MCP client (e.g., Claude Desktop `claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "fce-mcp": {
      "command": "npx",
      "args": ["-y", "fce-mcp-server"],
      "env": {
        "FCE_API_KEY": "your_growth_or_enterprise_api_key"
      }
    }
  }
}
```

**Option 2: From Source**
1. Clone this repository and navigate to `mcp-server/`.
2. Run `npm install` and `npm run build`.
3. Add to your configuration using `node` and the `build/index.js` path.

## Abuse & Limits

To ensure stability, MCP traffic runs through our Abuse Engine with strict limits applied *before* the normal rate-limiter:
1. **Ops/Minute Caps**: 60 for Growth, 200 for Enterprise.
2. **Timeout Caps**: Connections are forcefully closed after 60 seconds to prevent hanging.
3. **Multiplier Consumption**: Requests immediately deduct their respective multipliers (2x, 3x, 5x) from your monthly allocation.
