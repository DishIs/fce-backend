# FreeCustom.Email MCP SSE Hosting Guide

This guide explains how the FreeCustom.Email MCP server is hosted in production using **SSE (Server-Sent Events)** at `mcp.freecustom.email`. 

Hosting via SSE allows cloud-based AI tools (like Claude Web) to connect to your MCP server using a secure HTTPS URL, rather than relying on local `npx` commands.

## Architecture

The MCP server is integrated directly into the main `docker-compose.yml` at the root of this repository alongside your existing API, Redis, MongoDB, and SMTP infrastructure:

1. **MCP Server Container (`fce-mcp-server`)**: Runs in SSE transport mode (using Express), built from `./mcp-server/Dockerfile`.
2. **Nginx (main reverse proxy)**: Already configured in the root `docker-compose.yml` to route `mcp.freecustom.email` traffic to the MCP container.
3. **Certbot (existing)**: The main Certbot service now also requests a certificate for `mcp.freecustom.email` alongside `api2.freecustom.email` and `mx.freecustom.email`.

## How It Works

1. The MCP server container starts in SSE mode (`TRANSPORT=sse`).
2. Nginx routes incoming requests for `mcp.freecustom.email` to the `fce-mcp-server` container on port 3000.
3. The MCP server extracts the user's API key from the `Authorization: Bearer <API_KEY>` header dynamically—meaning multiple users can use the same hosted endpoint with their own distinct API keys.

## Deployment

Since the MCP server is integrated into the main `docker-compose.yml`, you just need to:

1. Ensure your DNS A-record for `mcp.freecustom.email` points to your server's IP.
2. Run the certbot manually once to generate the new certificate:

```bash
docker compose run --rm certbot certonly --webroot --webroot-path=/var/www/certbot --email dishantsinghdev@icloud.com --agree-tos --no-eff-email --key-type ecdsa --elliptic-curve secp384r1 -d mcp.freecustom.email
```

3. Restart Nginx to pick up the new domain:

```bash
docker compose exec nginx nginx -s reload
```

4. Build and start the MCP server:

```bash
docker compose up -d --build mcp-server
```

## How Cloud Agents Connect

When users want to use this hosted version in Claude Web or other remote AI agents, they must configure it to point to:
`https://mcp.freecustom.email/sse`

Since it's hosted publicly, the server dynamically extracts the API key from the incoming connection. **Users must pass their API key via the `Authorization: Bearer <API_KEY>` header** in their Claude connector settings.

## Endpoints

- **SSE Connection:** `https://mcp.freecustom.email/sse`
- **Message Handling:** `https://mcp.freecustom.email/messages?sessionId=<session>`
- **Health Check:** `https://mcp.freecustom.email/`