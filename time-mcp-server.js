#!/usr/bin/env node

/**
 * Time MCP Server
 * Wraps the Cloudflare Worker time service as an MCP tool
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// Worker URL - REQUIRED: Set TIME_WORKER_URL in your Claude Desktop config
// Example: "TIME_WORKER_URL": "https://time-mcp.YOUR-SUBDOMAIN.workers.dev"
const WORKER_URL = process.env.TIME_WORKER_URL || 'https://time-mcp.YOUR-SUBDOMAIN.workers.dev';

const server = new Server(
  {
    name: 'time-mcp',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'check_time',
        description: 'Get current time in UTC and local timezone format. Returns formatted time, date, and timezone information.',
        inputSchema: {
          type: 'object',
          properties: {
            timezone: {
              type: 'string',
              description: 'IANA timezone identifier (e.g., America/New_York, Europe/London). Defaults to UTC if not specified and no DEFAULT_TIMEZONE env variable is set.',
            },
          },
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'check_time') {
    try {
      // Timezone priority: explicit parameter > env variable > UTC fallback
      const timezone = request.params.arguments?.timezone || process.env.DEFAULT_TIMEZONE || 'UTC';

      // Use AbortController to prevent hanging requests from leaking memory
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      let response;
      try {
        response = await fetch(WORKER_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ timezone }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        throw new Error(`Worker returned ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error checking time: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }

  throw new Error(`Unknown tool: ${request.params.name}`);
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Time MCP server running');

  // Graceful shutdown to prevent memory leaks from dangling connections
  const cleanup = async () => {
    console.error('Shutting down Time MCP server...');
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
