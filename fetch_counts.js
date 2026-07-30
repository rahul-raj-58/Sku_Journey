#!/usr/bin/env node
/**
 * fetch_counts.js — Metabase → data/counts.json
 * ================================================
 * Run by GitHub Actions every hour (see .github/workflows/refresh-data.yml).
 * Reads MB_API_KEY from environment variable (stored as GitHub Secret).
 * Writes ./data/counts.json which the dashboard HTML reads.
 *
 * Local test:
 *   MB_API_KEY=mb_... node fetch_counts.js
 */

'use strict';
const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ── CONFIG ────────────────────────────────────────────────────────────────────
const MB_HOST  = 'metabase.spyne.ai';
const API_KEY  = process.env.MB_API_KEY;
const BASE_CARD = 12816;  // _SKU Journey Base v2 (is_360=0, all statuses)
const OUT_FILE  = path.join(__dirname, 'data', 'counts.json');
// ─────────────────────────────────────────────────────────────────────────────

if (!API_KEY) {
  console.error('ERROR: MB_API_KEY environment variable is not set.');
  console.error('Usage: MB_API_KEY=mb_xxx node fetch_counts.js');
  process.exit(1);
}

// ── Individual queries (UNION ALL hits ClickHouse memory limits on large tables)
const QUERIES = [
  ['v1_qc1_delivered',      `version='v1' AND is_qc_on=1 AND done_time IS NOT NULL AND qc_done_time IS NOT NULL`],
  ['v1_qc1_qc_pending',     `version='v1' AND is_qc_on=1 AND done_time IS NOT NULL AND qc_done_time IS NULL`],
  ['v1_qc1_tech_pending',   `version='v1' AND is_qc_on=1 AND done_time IS NULL`],
  ['v1_qc0_delivered',      `version='v1' AND is_qc_on=0 AND done_time IS NOT NULL`],
  ['v1_qc0_tech_pending',   `version='v1' AND is_qc_on=0 AND done_time IS NULL`],
  ['v2_qc0_delivered',      `version='v2' AND is_qc_on=0 AND done_time IS NOT NULL`],
  ['v2_qc0_tech_pending',   `version='v2' AND is_qc_on=0 AND done_time IS NULL`],
  ['v2_pub1_delivered',     `version='v2' AND is_qc_on=1 AND is_publishing=1 AND firstPushedAt IS NOT NULL`],
  ['v2_pub1_pub_pending',   `version='v2' AND is_qc_on=1 AND is_publishing=1 AND firstPushedAt IS NULL AND qc_done_time IS NOT NULL AND (now() - toDateTime(qc_done_time)) > 14400`],
  ['v2_pub1_to_push',       `version='v2' AND is_qc_on=1 AND is_publishing=1 AND firstPushedAt IS NULL AND qc_done_time IS NOT NULL AND (now() - toDateTime(qc_done_time)) <= 14400`],
  ['v2_pub1_qc_pending',    `version='v2' AND is_qc_on=1 AND is_publishing=1 AND qc_done_time IS NULL AND done_time IS NOT NULL`],
  ['v2_pub1_tech_pending',  `version='v2' AND is_qc_on=1 AND is_publishing=1 AND done_time IS NULL`],
  ['v2_pub0_delivered',     `version='v2' AND is_qc_on=1 AND is_publishing=0 AND qc_done_time IS NOT NULL`],
  ['v2_pub0_not_delivered', `version='v2' AND is_qc_on=1 AND is_publishing=0 AND qc_done_time IS NULL AND done_time IS NOT NULL`],
  ['v2_pub0_tech_pending',  `version='v2' AND is_qc_on=1 AND is_publishing=0 AND done_time IS NULL`],
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── HTTP helper ───────────────────────────────────────────────────────────────
function mbCount(where, retries = 3) {
  const sql = `SELECT count() FROM {{#${BASE_CARD}}} AS b WHERE ${where}`;
  const body = JSON.stringify({
    database: 350,
    type: 'native',
    native: {
      query: sql,
      template_tags: {
        [`#${BASE_CARD}`]: {
          id: `card-${BASE_CARD}`, name: `#${BASE_CARD}`,
          display_name: `Card ${BASE_CARD}`, type: 'card', card_id: BASE_CARD,
        }
      }
    }
  });

  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      const req = https.request({
        hostname: MB_HOST, path: '/api/dataset', method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'x-api-key': API_KEY,
        },
        timeout: 120_000,
      }, res => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => {
          try {
            const data = JSON.parse(raw);
            if (data.error) {
              if (n > 1 && data.error.includes('MEMORY_LIMIT')) {
                console.warn(`  Memory limit hit, retrying in 10s… (${n-1} left)`);
                return sleep(10_000).then(() => attempt(n - 1));
              }
              return reject(new Error(data.error));
            }
            resolve(Number(data?.data?.rows?.[0]?.[0] ?? 0));
          } catch (e) { reject(new Error(`Parse error: ${e.message}`)); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout after 120s')); });
      req.write(body);
      req.end();
    };
    attempt(retries);
  });
}

// ── MAIN ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`[${new Date().toISOString()}] Fetching ${QUERIES.length} metrics from Metabase…`);
  const counts = { updated_at: new Date().toISOString() };

  for (const [metric, where] of QUERIES) {
    process.stdout.write(`  ${metric}… `);
    try {
      const val = await mbCount(where);
      counts[metric] = val;
      console.log(val.toLocaleString());
    } catch (err) {
      console.error(`FAILED: ${err.message}`);
      counts[metric] = null;   // null in JSON signals "query failed" to the dashboard
    }
    // Small pause between queries to avoid overwhelming ClickHouse
    await sleep(2_000);
  }

  console.log('\nFinal counts:', counts);
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(counts, null, 2));
  console.log(`Written → ${OUT_FILE}`);
})();
