#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios from 'axios';

const API_KEY = process.env.FCE_API_KEY;
if (!API_KEY) {
  throw new Error('FCE_API_KEY environment variable is required');
}

// Ensure the Base URL handles the MCP prefix if you want it to directly call /v1/mcp
// e.g. https://api.freecustom.email/v1/mcp
const BASE_URL = process.env.FCE_API_URL || 'https://api.freecustom.email/v1/mcp';

// Create an MCP server
const server = new McpServer({
  name: "fce-mcp",
  version: "1.0.0"
});

// Create axios instance
const apiClient = axios.create({
  baseURL: BASE_URL,
  headers: {
    'Authorization': `Bearer ${API_KEY}`,
    'Content-Type': 'application/json'
  },
  // Set high timeout for long-polling endpoints
  timeout: 70000 
});

// Helper for error formatting
function formatError(error: unknown) {
  if (axios.isAxiosError(error)) {
    return `API error: ${error.response?.data?.message ?? error.response?.data?.error ?? error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

// 1. Tool: get_latest_email
server.tool(
  "get_latest_email",
  {
    inbox: z.string().describe("The full email address of the inbox (e.g. hello@ditube.info)"),
  },
  async ({ inbox }) => {
    try {
      const response = await apiClient.get(`/inboxes/${inbox}/messages/latest`);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(response.data, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: formatError(error) }],
        isError: true,
      };
    }
  }
);

// 2. Tool: extract_otp
server.tool(
  "extract_otp",
  {
    inbox: z.string().describe("The full email address of the inbox to extract OTP from"),
  },
  async ({ inbox }) => {
    try {
      const response = await apiClient.get(`/inboxes/${inbox}/otp`);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(response.data, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: formatError(error) }],
        isError: true,
      };
    }
  }
);

// 3. Tool: create_and_wait_for_otp
server.tool(
  "create_and_wait_for_otp",
  {
    domain: z.string().optional().describe("Optional domain to use. Defaults to ditube.info"),
    timeout: z.number().min(10).max(60).optional().describe("Max wait time in seconds (10-60). Default 45."),
  },
  async ({ domain, timeout }) => {
    try {
      const response = await apiClient.post(`/create-and-wait-otp`, {
        domain: domain || 'ditube.info',
        timeout: timeout || 45
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(response.data, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: formatError(error) }],
        isError: true,
      };
    }
  }
);

// Start receiving messages on stdin and sending messages on stdout
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('FreeCustom.Email MCP server running on stdio');
}

main().catch(console.error);
