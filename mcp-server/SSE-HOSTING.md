# FreeCustom.Email MCP SSE Hosting Guide

This guide explains how the FreeCustom.Email MCP server is deployed in production at `mcp.freecustom.email`. 

The MCP server runs as a container in the main Docker Compose stack alongside your API, Redis, MongoDB, and SMTP services. It uses **SSE (Server-Sent Events)** to allow cloud-based AI tools (like Claude Web) to connect via a secure HTTPS URL.

## Architecture

The MCP server is fully integrated into `docker-compose.yml`:

| Component | Description |
| :--- | :--- |
| **mcp-server** | Node.js container running in SSE mode (port 3001) |
| **nginx** | Routes `mcp.freecustom.email` to the MCP container |
| **certbot** | Already configured to request SSL for `mcp.freecustom.email` |

## Deployment

When you run `docker compose up -d`, the MCP server will automatically:

1. Build from `./mcp-server/Dockerfile`
2. Start in SSE mode (`TRANSPORT=sse`)
3. Connect to your existing Redis for session management
4. Be accessible via Nginx at `https://mcp.freecustom.email/sse`

### Initial SSL Certificate

On first deployment, run the certbot manually to get the certificate for `mcp.freecustom.email`:

```bash
docker compose run --rm certbot certonly --webroot --webroot-path=/var/www/certbot --email dishantsinghdev@icloud.com --agree-tos --no-eff-email --key-type ecdsa --elliptic-curve secp384r1 -d mcp.freecustom.email
```

Then reload nginx:

```bash
docker compose exec nginx nginx -s reload
```

### Verify

```bash
curl https://mcp.freecustom.email/
```

You should see: `FreeCustom.Email MCP Server is running.`

## Configuration

The MCP server uses these environment variables (already set in docker-compose.yml):

| Variable | Default | Description |
| :--- | :--- | :--- |
| `TRANSPORT` | `sse` | Run in SSE mode for web agents |
| `PORT` | `3001` | Container port (avoid conflict with API on 3000) |
| `FCE_API_URL` | `https://api2.freecustom.email/v1/mcp` | Backend API endpoint |

## How Users Connect

Users can connect to your hosted MCP endpoint:

- **SSE URL:** `https://mcp.freecustom.email/sse`
- **Message endpoint:** `https://mcp.freecustom.email/messages?sessionId=<id>`

They must pass their FreeCustom.Email API key via the `Authorization: Bearer <API_KEY>` header.

For Claude Web: Use `https://mcp.freecustom.email/sse` as the "Remote MCP Server URL" and put their API key in the OAuth Client ID field.