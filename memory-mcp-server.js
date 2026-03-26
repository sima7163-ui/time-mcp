#!/usr/bin/env node

/**
 * Memory MCP Server
 * Wraps the Cloudflare Worker memory service as MCP tools for Claude.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// Worker URL - REQUIRED: Set MEMORY_WORKER_URL in your Claude Desktop config
const WORKER_URL = process.env.MEMORY_WORKER_URL;
const MEMORY_SECRET = process.env.MEMORY_SECRET;

if (!WORKER_URL || !MEMORY_SECRET) {
  console.error('ERROR: MEMORY_WORKER_URL and MEMORY_SECRET environment variables are required.');
  console.error('Set them in your Claude Desktop config under "env".');
  process.exit(1);
}

const server = new Server(
  { name: 'memory-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// Helper: make authenticated request to memory worker
async function workerFetch(path, options = {}) {
  const separator = path.includes('?') ? '&' : '?';
  const url = `${WORKER_URL}${path}${separator}secret=${MEMORY_SECRET}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || `Worker returned ${response.status}`);
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'save_memory',
        description: 'Save a memory/note for later recall. Use this to remember important facts, preferences, or context about the user.',
        inputSchema: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description: 'The memory content to save.',
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional tags for categorizing the memory (e.g., ["preference", "name"]).',
            },
          },
          required: ['content'],
        },
      },
      {
        name: 'recall_memories',
        description: 'Search and recall saved memories. Use this at the start of conversations or when you need to remember something about the user.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Text to search for in memories.',
            },
            tag: {
              type: 'string',
              description: 'Filter by a specific tag.',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of memories to return (default 50).',
            },
          },
        },
      },
      {
        name: 'delete_memory',
        description: 'Delete a specific memory by its ID.',
        inputSchema: {
          type: 'object',
          properties: {
            id: {
              type: 'number',
              description: 'The ID of the memory to delete.',
            },
          },
          required: ['id'],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === 'save_memory') {
      const data = await workerFetch('/memories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: args.content, tags: args.tags }),
      });
      return {
        content: [{ type: 'text', text: `Memory saved (ID: ${data.id})` }],
      };
    }

    if (name === 'recall_memories') {
      const params = new URLSearchParams();
      if (args?.query) params.set('q', args.query);
      if (args?.tag) params.set('tag', args.tag);
      if (args?.limit) params.set('limit', String(args.limit));
      const qs = params.toString();
      const data = await workerFetch(`/memories${qs ? '?' + qs : ''}`);
      if (data.memories.length === 0) {
        return { content: [{ type: 'text', text: 'No memories found.' }] };
      }
      const formatted = data.memories.map(m =>
        `[${m.id}] (${m.created_at}) ${m.content}${m.tags.length ? ' [' + m.tags.join(', ') + ']' : ''}`
      ).join('\n');
      return {
        content: [{ type: 'text', text: `Found ${data.count} memories:\n\n${formatted}` }],
      };
    }

    if (name === 'delete_memory') {
      await workerFetch(`/memories/${args.id}`, { method: 'DELETE' });
      return {
        content: [{ type: 'text', text: `Memory ${args.id} deleted.` }],
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

// Start
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Memory MCP server running');

  const cleanup = async () => {
    console.error('Shutting down Memory MCP server...');
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
