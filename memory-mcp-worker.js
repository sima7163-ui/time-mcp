/**
 * Memory MCP - Cloudflare Worker
 *
 * Stores and retrieves memories using Cloudflare D1 (SQLite).
 * Authenticates requests with a shared secret.
 *
 * Environment bindings required:
 *   - DB: D1 database
 *   - AUTH_SECRET: shared secret for request authentication
 */

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
      });
    }

    const corsHeaders = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    };

    // Authenticate via ?secret= param or Authorization header
    const url = new URL(request.url);
    const secret = url.searchParams.get('secret') || request.headers.get('Authorization')?.replace('Bearer ', '');
    if (!secret || secret !== env.AUTH_SECRET) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
    }

    const path = url.pathname;

    try {
      // Initialize table on first use
      await env.DB.exec(`
        CREATE TABLE IF NOT EXISTS memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          content TEXT NOT NULL,
          tags TEXT DEFAULT '',
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);

      // POST /memories - save a memory
      if (path === '/memories' && request.method === 'POST') {
        const { content, tags } = await request.json();
        if (!content) {
          return new Response(JSON.stringify({ error: 'content is required' }), { status: 400, headers: corsHeaders });
        }
        const tagsStr = Array.isArray(tags) ? tags.join(',') : (tags || '');
        const result = await env.DB.prepare('INSERT INTO memories (content, tags) VALUES (?, ?)')
          .bind(content, tagsStr)
          .run();
        return new Response(JSON.stringify({
          success: true,
          id: result.meta.last_row_id,
          message: 'Memory saved',
        }), { headers: corsHeaders });
      }

      // GET /memories - list/search memories
      if (path === '/memories' && request.method === 'GET') {
        const query = url.searchParams.get('q') || '';
        const tag = url.searchParams.get('tag') || '';
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);

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
        params.push(limit);

        const { results } = await env.DB.prepare(sql).bind(...params).all();

        // Parse tags back to arrays
        const memories = results.map(m => ({
          ...m,
          tags: m.tags ? m.tags.split(',').filter(Boolean) : [],
        }));

        return new Response(JSON.stringify({ memories, count: memories.length }), { headers: corsHeaders });
      }

      // DELETE /memories/:id - delete a memory
      if (path.startsWith('/memories/') && request.method === 'DELETE') {
        const id = parseInt(path.split('/').pop());
        if (isNaN(id)) {
          return new Response(JSON.stringify({ error: 'Invalid memory ID' }), { status: 400, headers: corsHeaders });
        }
        await env.DB.prepare('DELETE FROM memories WHERE id = ?').bind(id).run();
        return new Response(JSON.stringify({ success: true, message: 'Memory deleted' }), { headers: corsHeaders });
      }

      // Health check
      if (path === '/health') {
        return new Response(JSON.stringify({ status: 'ok', service: 'memory-mcp' }), { headers: corsHeaders });
      }

      return new Response(JSON.stringify({ error: 'Not found', endpoints: ['POST /memories', 'GET /memories', 'DELETE /memories/:id'] }), {
        status: 404,
        headers: corsHeaders,
      });

    } catch (error) {
      return new Response(JSON.stringify({ error: 'Internal error', message: error.message }), {
        status: 500,
        headers: corsHeaders,
      });
    }
  },
};
