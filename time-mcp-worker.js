/**
 * Time MCP - Cloudflare Worker
 * 
 * A simple, lightweight time service that returns current time
 * in both UTC and local timezone formats.
 * 
 * Built by Jess & Cecil - March 2026
 */

// Cache Intl.DateTimeFormat instances to avoid re-creating them on every request
const formatterCache = new Map();

function getFormatter(timezone, options) {
  const key = `${timezone}:${JSON.stringify(options)}`;
  let fmt = formatterCache.get(key);
  if (!fmt) {
    // Cap cache size to prevent unbounded memory growth
    if (formatterCache.size >= 200) {
      const firstKey = formatterCache.keys().next().value;
      formatterCache.delete(firstKey);
    }
    fmt = new Intl.DateTimeFormat('en-US', { timeZone: timezone, ...options });
    formatterCache.set(key, fmt);
  }
  return fmt;
}

export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    try {
      // Parse request body if it's a POST
      let timezone = 'UTC'; // Default to UTC
      
      if (request.method === 'POST') {
        const body = await request.json();
        if (body.timezone) {
          timezone = body.timezone;
        }
      }

      // Get current time
      const now = new Date();
      
      // Use cached formatters to avoid memory churn from re-creating Intl objects
      const localTimeFormatter = getFormatter(timezone, {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      });

      const dateFormatter = getFormatter(timezone, {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });

      const timezoneFormatter = getFormatter(timezone, {
        timeZoneName: 'short',
      });
      
      // Extract timezone abbreviation (EST, PST, etc.)
      const timezoneParts = timezoneFormatter.formatToParts(now);
      const timezoneAbbr = timezoneParts.find(part => part.type === 'timeZoneName')?.value || timezone;
      
      // Build response
      const response = {
        utc: now.toISOString(),
        local_time: localTimeFormatter.format(now),
        date: dateFormatter.format(now),
        timezone: timezoneAbbr,
        full_timezone: timezone,
      };

      return new Response(JSON.stringify(response, null, 2), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });

    } catch (error) {
      return new Response(JSON.stringify({
        error: 'Failed to get time',
        message: error.message,
      }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }
  },
};
