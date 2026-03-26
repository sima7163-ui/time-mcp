/**
 * Memory MCP - Cloudflare Worker
 *
 * Remote MCP server that stores memories in Cloudflare D1 (SQLite).
 * Claude Desktop connects directly to this via URL - no Node.js needed.
 *
 * Environment bindings required in wrangler.toml / Cloudflare Dashboard:
 *   - DB: D1 database
 *   - AUTH_SECRET: shared secret for request authentication
 */

// ============================================================
// MCP Protocol helpers
// ============================================================

function jsonrpc(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function jsonrpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

// ============================================================
// Memory DB helpers
// ============================================================

async function initDB(db) {
  await db.prepare("CREATE TABLE IF NOT EXISTS memories (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, tags TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')))").run();
}

async function saveMemory(db, content, tags) {
  const tagsStr = Array.isArray(tags) ? tags.join(',') : (tags || '');
  const result = await db.prepare('INSERT INTO memories (content, tags) VALUES (?, ?)')
    .bind(content, tagsStr)
    .run();
  return result.meta.last_row_id;
}

async function searchMemories(db, query, tag, limit) {
  let sql = 'SELECT * FROM memories';
  const conditions = [];
  const params = [];

  if (query) {
    conditions.push('content LIKE ?');
    params.push(`%${query}%`);
  }
  if (tag) {
    conditions.push("(',' || tags || ',') LIKE ?");
    params.push(`%,${tag},%`);
  }
  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(Math.min(limit || 50, 200));

  const { results } = await db.prepare(sql).bind(...params).all();
  return results.map(m => ({
    ...m,
    tags: m.tags ? m.tags.split(',').filter(Boolean) : [],
  }));
}

async function deleteMemory(db, id) {
  await db.prepare('DELETE FROM memories WHERE id = ?').bind(id).run();
}

// ============================================================
// MCP tool definitions
// ============================================================

const TOOLS = [
  {
    name: 'save_memory',
    description: 'Save a memory/note for later recall. Use this to remember important facts, preferences, or context about the user.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The memory content to save.' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags for categorizing (e.g. ["preference", "name"]).',
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'recall_memories',
    description: 'Search and recall saved memories. Use at the start of conversations or when you need context about the user.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to search for in memories.' },
        tag: { type: 'string', description: 'Filter by a specific tag.' },
        limit: { type: 'number', description: 'Max memories to return (default 50, max 200).' },
      },
    },
  },
  {
    name: 'delete_memory',
    description: 'Delete a specific memory by its ID.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'The ID of the memory to delete.' },
      },
      required: ['id'],
    },
  },
];

// ============================================================
// Handle a single MCP JSON-RPC request
// ============================================================

async function handleMCPRequest(msg, db) {
  const { id, method, params } = msg;

  // Initialize
  if (method === 'initialize') {
    return jsonrpc(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'memory-mcp', version: '1.0.0' },
    });
  }

  // Ping
  if (method === 'ping') {
    return jsonrpc(id, {});
  }

  // Notifications (no response needed)
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
    return null;
  }

  // List tools
  if (method === 'tools/list') {
    return jsonrpc(id, { tools: TOOLS });
  }

  // Call tool
  if (method === 'tools/call') {
    const toolName = params?.name;
    const args = params?.arguments || {};

    try {
      await initDB(db);

      if (toolName === 'save_memory') {
        if (!args.content) {
          return jsonrpc(id, {
            content: [{ type: 'text', text: 'Error: content is required' }],
            isError: true,
          });
        }
        const memId = await saveMemory(db, args.content, args.tags);
        return jsonrpc(id, {
          content: [{ type: 'text', text: `Memory saved (ID: ${memId})` }],
        });
      }

      if (toolName === 'recall_memories') {
        const memories = await searchMemories(db, args.query, args.tag, args.limit);
        if (memories.length === 0) {
          return jsonrpc(id, {
            content: [{ type: 'text', text: 'No memories found.' }],
          });
        }
        const formatted = memories.map(m =>
          `[${m.id}] (${m.created_at}) ${m.content}${m.tags.length ? ' [' + m.tags.join(', ') + ']' : ''}`
        ).join('\n');
        return jsonrpc(id, {
          content: [{ type: 'text', text: `Found ${memories.length} memories:\n\n${formatted}` }],
        });
      }

      if (toolName === 'delete_memory') {
        if (!args.id) {
          return jsonrpc(id, {
            content: [{ type: 'text', text: 'Error: id is required' }],
            isError: true,
          });
        }
        await deleteMemory(db, args.id);
        return jsonrpc(id, {
          content: [{ type: 'text', text: `Memory ${args.id} deleted.` }],
        });
      }

      return jsonrpc(id, {
        content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
        isError: true,
      });
    } catch (err) {
      return jsonrpc(id, {
        content: [{ type: 'text', text: `Error: ${err.message}` }],
        isError: true,
      });
    }
  }

  return jsonrpcError(id, -32601, `Method not found: ${method}`);
}

// ============================================================
// Main Worker
// ============================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Authenticate via ?secret= param
    const secret = url.searchParams.get('secret');
    if (!secret || secret !== env.AUTH_SECRET) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    const path = url.pathname;

    // ---- MCP endpoint (POST /mcp) ----
    if (path === '/mcp' && request.method === 'POST') {
      try {
        const msg = await request.json();
        const result = await handleMCPRequest(msg, env.DB);

        if (!result) {
          // Notification - no response body needed
          return new Response(null, { status: 204, headers: corsHeaders });
        }

        return new Response(JSON.stringify(result), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      } catch (err) {
        return new Response(JSON.stringify(jsonrpcError(null, -32700, `Parse error: ${err.message}`)), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
    }

    // ---- SSE endpoint (GET /mcp) for MCP Streamable HTTP ----
    if (path === '/mcp' && request.method === 'GET') {
      const endpointUrl = `${url.origin}/mcp?secret=${secret}`;
      const sseBody = `event: endpoint\ndata: ${endpointUrl}\n\n`;

      return new Response(sseBody, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          ...corsHeaders,
        },
      });
    }

    // ---- Health check ----
    if (path === '/health') {
      return new Response(JSON.stringify({ status: 'ok', service: 'memory-mcp' }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    return new Response(JSON.stringify({ error: 'Not found. Use /mcp endpoint.' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  },
};
