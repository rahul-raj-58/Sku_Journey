#!/usr/bin/env node
/**
 * SKU Journey Dashboard — Local Proxy Server (Node.js)
 * =====================================================
 * Serves the HTML dashboard AND proxies Metabase API calls to avoid CORS.
 * Cache TTL: 5 minutes (configurable below).
 * Requires: Node.js v18+ (built-in fetch) — no npm install needed.
 *
 * Usage:
 *   node sku_dashboard_server.js
 *   Then open: http://localhost:8765
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

// ── CONFIG ────────────────────────────────────────────────────────────────────
const MB_BASE    = 'https://metabase.spyne.ai';
const MB_API_KEY = 'mb_BbbOBUMM+s1sUJTquApMnybzWwQtIjlpSmpnATkDyOc=';
const BASE_CARD  = 12816;   // slim base card (is_360=0, all statuses)
const DB_ID      = 350;
const PORT       = 8765;
const CACHE_TTL  = 300;     // seconds (5 min). Set to 0 to disable.
const HTML_FILE  = path.join(__dirname, 'sku_journey_v2.html');
// ─────────────────────────────────────────────────────────────────────────────

const cache = new Map(); // key -> { rows, cols, cachedAt }

function mbQuery(sql, force = false) {
  return new Promise((resolve, reject) => {
    const key = sql.trim();
    const now = Date.now() / 1000;

    if (!force) {
      const entry = cache.get(key);
      if (entry && (now - entry.cachedAt) < CACHE_TTL) {
        return resolve({
          rows:     entry.rows,
          cols:     entry.cols,
          cached:   true,
          cachedAt: entry.cachedAt,
          age_s:    Math.round(now - entry.cachedAt),
        });
      }
    }

    const body = JSON.stringify({
      database: DB_ID,
      type: 'native',
      native: {
        query: sql,
        template_tags: {
          [`#${BASE_CARD}`]: {
            id:           `card-${BASE_CARD}`,
            name:         `#${BASE_CARD}`,
            display_name: `Card ${BASE_CARD}`,
            type:         'card',
            card_id:      BASE_CARD,
          }
        }
      }
    });

    const parsed = new URL(`${MB_BASE}/api/dataset`);
    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || 443,
      path:     parsed.pathname,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-api-key':      MB_API_KEY,
      },
      timeout: 90000,
    };

    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try {
          const data = JSON.parse(raw);
          if (data.error) return reject(new Error(data.error));
          const rows = data?.data?.rows || [];
          const cols = (data?.data?.cols || []).map(c => c.name);
          cache.set(key, { rows, cols, cachedAt: now });
          resolve({ rows, cols, cached: false, cachedAt: now, age_s: 0 });
        } catch (e) {
          reject(new Error(`Parse error: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Metabase request timed out (90s)')); });
    req.write(body);
    req.end();
  });
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const { pathname } = url.parse(req.url);
  const ts = new Date().toTimeString().slice(0,8);

  // ── OPTIONS ──
  if (req.method === 'OPTIONS') {
    cors(res);
    res.writeHead(200);
    res.end();
    return;
  }

  // ── GET / ──
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    console.log(`  [${ts}] GET  /  → serving dashboard`);
    try {
      const content = fs.readFileSync(HTML_FILE);
      cors(res);
      res.writeHead(200, {
        'Content-Type':   'text/html; charset=utf-8',
        'Content-Length': content.length,
        'Cache-Control':  'no-store',
      });
      res.end(content);
    } catch {
      res.writeHead(404); res.end('HTML file not found: ' + HTML_FILE);
    }
    return;
  }

  // ── GET /cache-status ──
  if (req.method === 'GET' && pathname === '/cache-status') {
    const now = Date.now() / 1000;
    const entries = {};
    cache.forEach((v, k) => {
      entries[k.slice(0, 80) + '…'] = {
        age_s:      Math.round(now - v.cachedAt),
        rows:       v.rows.length,
        expires_in: Math.max(0, CACHE_TTL - Math.round(now - v.cachedAt)),
      };
    });
    json(res, 200, { entries: cache.size, ttl_s: CACHE_TTL, queries: entries });
    return;
  }

  // ── GET /clear-cache ──
  if (req.method === 'GET' && pathname === '/clear-cache') {
    const n = cache.size;
    cache.clear();
    json(res, 200, { cleared: n });
    console.log(`  [${ts}] Cache cleared (${n} entries)`);
    return;
  }

  // ── POST /query ──
  if (req.method === 'POST' && pathname === '/query') {
    let raw = '';
    req.on('data', chunk => raw += chunk);
    req.on('end', async () => {
      try {
        const { sql, force } = JSON.parse(raw);
        if (!sql) return json(res, 400, { error: "Missing 'sql' field" });
        console.log(`  [${ts}] POST /query  force=${force}  sql=${sql.trim().slice(0,60)}…`);
        const result = await mbQuery(sql, force === true);
        console.log(`  [${ts}]   → ${result.rows.length} rows  cached=${result.cached}  age=${result.age_s}s`);
        json(res, 200, result);
      } catch (err) {
        console.error(`  [${ts}] ERROR: ${err.message}`);
        json(res, 500, { error: err.message });
      }
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, 'localhost', () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║  SKU Journey Dashboard — Proxy Server        ║');
  console.log(`  ║  http://localhost:${PORT}                       ║`);
  console.log(`  ║  Cache TTL : ${CACHE_TTL}s (${CACHE_TTL/60} min)                  ║`);
  console.log(`  ║  Metabase  : ${MB_BASE.slice(8, 36)}  ║`);
  console.log('  ╠══════════════════════════════════════════════╣');
  console.log('  ║  Open the URL above in Chrome                ║');
  console.log('  ║  Press Ctrl+C to stop                        ║');
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('');
});
