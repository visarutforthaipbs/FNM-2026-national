#!/usr/bin/env node

/**
 * Vercel MCP Bridge for Antigravity
 *
 * Exposes the official remote Vercel MCP server (https://mcp.vercel.com)
 * as a local stdio MCP server for Antigravity / Gemini IDE.
 *
 * Reads auth token directly from the local Vercel CLI config:
 * ~/Library/Application Support/com.vercel.cli/auth.json
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

// 1. Locate Vercel CLI token
function getVercelToken() {
  const candidates = [
    process.env.VERCEL_TOKEN,
    path.join(os.homedir(), 'Library/Application Support/com.vercel.cli/auth.json'),
    path.join(os.homedir(), '.local/share/com.vercel.cli/auth.json'),
    path.join(os.homedir(), '.config/com.vercel.cli/auth.json'),
  ].filter(Boolean);

  for (const c of candidates) {
    if (typeof c === 'string' && !c.includes(path.sep) && c.length > 20) {
      return c; // Environment variable value
    }
    if (fs.existsSync(c)) {
      try {
        const data = JSON.parse(fs.readFileSync(c, 'utf8'));
        if (data.token) return data.token;
      } catch (err) {
        // continue
      }
    }
  }
  return null;
}

const token = getVercelToken();
if (!token) {
  process.stderr.write('⚠️ [vercel-mcp-bridge] No Vercel authentication token found.\n');
  process.exit(1);
}

// 2. Setup Stdio Line Reader
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let request;
  try {
    request = JSON.parse(trimmed);
  } catch (err) {
    process.stderr.write(`[vercel-mcp-bridge] Failed to parse input JSON: ${err.message}\n`);
    return;
  }

  // Forward JSON-RPC request to Vercel MCP HTTP endpoint
  try {
    const res = await fetch('https://mcp.vercel.com/', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(request),
    });

    const bodyText = await res.text();
    // Parse SSE lines
    const lines = bodyText.split('\n');
    for (const l of lines) {
      if (l.startsWith('data: ')) {
        const dataJson = l.slice(6).trim();
        process.stdout.write(dataJson + '\n');
      }
    }
  } catch (err) {
    process.stderr.write(`[vercel-mcp-bridge] Request failed: ${err.message}\n`);
    if (request.id !== undefined) {
      const errorResponse = {
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: -32603,
          message: `Internal error communicating with Vercel MCP: ${err.message}`,
        },
      };
      process.stdout.write(JSON.stringify(errorResponse) + '\n');
    }
  }
});
