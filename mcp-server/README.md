# FreeCustom.Email MCP Server

[![npm version](https://badge.fury.io/js/fce-mcp-server.svg)](https://badge.fury.io/js/fce-mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

The official **Model Context Protocol (MCP)** server for [FreeCustom.Email API](https://www.freecustom.email/api). 

This server provides the ultimate **temp mail API** and **temp mail automation** capabilities specifically designed for AI agents (Claude, Cursor, Windsurf, Kilo Code, etc.). Instead of building complex polling logic to wait for emails and extract OTPs, your AI agents can now create inboxes, wait for emails, and extract verification codes in a single tool call.

## The Ultimate Temp Mail for AI Agents

Traditional temporary email API providers (like Mailinator, Maildrop, 1secmail, or Guerrilla Mail) are built for human consumption or basic REST polling. They lack the context and connection needed for advanced AI workflows. 

**Why FreeCustom.Email is better for AI:**

| Feature | Traditional Temp Mail APIs | FreeCustom.Email MCP |
| :--- | :--- | :--- |
| **Agent Interface** | Manual HTTP REST requests | Native MCP (Model Context Protocol) Tools |
| **Wait for Email** | Constant polling (hits rate limits) | Long-polling & Pub/Sub (Zero extra requests) |
| **Action Economy** | 3-5 operations to get an OTP | 1-shot tool (`create_and_wait_for_otp`) |
| **Data Parsing** | AI must parse messy HTML/Text | Server automatically extracts 4-6 digit OTPs |

Whether you are doing **temp mail testing**, automated QA, or autonomous AI agent signups, this MCP server handles the complexity behind the scenes.

## Prerequisites

To use this MCP server, you must have a **Growth** or **Enterprise** plan on FreeCustom.Email, as this is a premium AI automation feature.

You will need your API key, which can be found in your FreeCustom.Email dashboard.

> **Want to use MCP in web-based AI tools?** We host a public MCP endpoint at `https://mcp.freecustom.email/mcp` that works with Claude Web, OpenAI Playground, Replit Agent, and any other cloud AI platform—no local installation required. Just pass your API key via the `Authorization: Bearer` header or use OAuth.

## Installation & Configuration

### For Claude Desktop (Local Stdio)

1. Open your Claude Desktop configuration file based on your Operating System:
   - **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
   - **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

2. Add the following to the configuration:

```json
{
  "mcpServers": {
    "fce-mcp": {
      "command": "npx",
      "args": ["-y", "fce-mcp-server"],
      "env": {
        "FCE_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

### For Claude Web Chat (claude.ai)

The Claude web interface requires a **Remote MCP Server URL**. We provide a hosted MCP endpoint at `https://mcp.freecustom.email/mcp` that works directly with Claude Web using OAuth.

1. Open [Claude Web](https://claude.ai) (or the Claude app on mobile).
2. Go to **Settings** > **Integrations** > **Add Custom Connector**.
3. Fill in the details:
   - **Name:** `FreeCustom.Email MCP`
   - **Remote MCP Server URL:** `https://mcp.freecustom.email/mcp`
4. Under **Advanced settings**, add your API key as the **OAuth Client ID** (or just paste your FreeCustom.Email API key).
5. Click **Connect**.

### For Cursor

1. Open Cursor Settings.
2. Navigate to **Features** > **MCP Servers**.
3. Click **Add New MCP Server**.
4. Set the Type to `command`.
5. Name it `fce-mcp`.
6. Command: `npx -y fce-mcp-server`
7. In your system environment variables, ensure `FCE_API_KEY` is set.

### For Windsurf / Windsurf Editor

```json
{
  "mcpServers": {
    "fce-mcp": {
      "command": "npx",
      "args": ["-y", "fce-mcp-server"],
      "env": {
        "FCE_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

### For Kilo CLI & Kilo Code

```json
{
  "mcp": {
    "fce-mcp": {
      "type": "local",
      "command": ["npx", "-y", "fce-mcp-server"],
      "environment": {
        "FCE_API_KEY": "your_api_key_here"
      },
      "enabled": true
    }
  }
}
```

### For Web-Based AI Platforms

Many AI platforms require an HTTP endpoint. Use our hosted MCP endpoint:

| Platform | How to Configure |
| :--- | :--- |
| **Claude.ai (Web)** | Settings → Integrations → Add Custom Connector → URL: `https://mcp.freecustom.email/mcp` |
| **OpenAI Playground** | Use custom "OpenAI Agents" with our MCP URL |
| **Replit Agent** | Add MCP server with URL: `https://mcp.freecustom.email/mcp` + Bearer token auth |
| **Agentops / LangChain** | Configure MCP client with our URL, pass `Authorization: Bearer <YOUR_API_KEY>` |

## Available Tools

Once connected, your AI agent will have access to the following tools:

### Email Operations

#### `create_and_wait_for_otp` (🔥 GOLD FEATURE)
Generates a random inbox and holds the connection open until an OTP arrives.
- **`domain`** (optional): Domain to use (defaults to `ditube.info`)
- **`timeout`** (optional): Max wait time in seconds (10-60, defaults to 45)

#### `get_latest_email`
Retrieves the most recent email for a given inbox.
- **`inbox`** (required): Full email address (e.g. `hello@ditube.info`)

#### `extract_otp`
Directly retrieves the latest 4-6 digit code or verification link.
- **`inbox`** (required): Full email address of the inbox

#### `watch_email`
Long-polling wait for new emails on an existing inbox.
- **`inbox`** (required): Full email address of the inbox to watch
- **`timeout`** (optional): Max wait time in seconds (10-60, defaults to 30)
- **`since`** (optional): Message ID to wait for newer messages after

#### `get_messages`
Fetches multiple messages from an inbox.
- **`inbox`** (required): Full email address
- **`limit`** (optional): Number of messages (1-100, default 10)
- **`unread_only`** (optional): Only fetch unread messages

#### `delete_email`
Deletes a specific email from an inbox.
- **`inbox`** (required): Full email address
- **`message_id** (required): The message ID to delete

### Inbox Management

#### `list_inboxes`
Lists all inboxes owned by the API key's account. (no args)

### Custom Domain Management

#### `list_custom_domains`
Lists all custom domains associated with the account. (no args)

#### `add_custom_domain`
Adds a new custom domain to the account.
- **`domain`** (required): The custom domain (e.g. `mail.yourdomain.com`)

#### `verify_custom_domain`
Initiates DNS verification for a custom domain.
- **`domain`** (required): The custom domain to verify

#### `delete_custom_domain`
Deletes a custom domain from the account.
- **`domain`** (required): The custom domain to delete

## Plan Requirements

MCP access requires a **Growth** or **Enterprise** plan:
- **Growth**: 60 ops/minute, 5 concurrent sessions
- **Enterprise**: 200 ops/minute, 10 concurrent sessions

## Troubleshooting

**"I don't have tools available"**
If your AI agent says it doesn't have tools, the MCP server failed to load.
- **Restart the App:** Desktop agents only read the config on startup. Quit completely and reopen.
- **Check Logs:** For Claude on macOS: `tail -n 50 ~/Library/Logs/Claude/mcp*.log`

**"Using Claude Web (claude.ai)"**
If getting OAuth/token errors:
- Use **Remote MCP Server URL:** `https://mcp.freecustom.email/mcp` (not `/sse`)
- Ensure your API key is valid and you have a Growth/Enterprise plan

**"npx: command not found"**
GUI apps may not inherit your `$PATH`. Use absolute paths:

```json
{
  "mcpServers": {
    "fce-mcp": {
      "command": "/usr/local/bin/node", 
      "args": ["/absolute/path/to/fce-mcp-server/build/index.js"],
      "env": { "FCE_API_KEY": "your_api_key_here" }
    }
  }
}
```

## License

MIT
