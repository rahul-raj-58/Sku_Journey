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

// ── UNION ALL query: returns one row per metric ───────────────────────────────
// Each subquery filters on card 12816 (is_360 IN ('0','false'))
const SQL = `
SELECT 'v1_qc1_delivered'      AS metric, count() AS val FROM {{#${BASE_CARD}}} AS b WHERE version='v1' AND is_qc_on=1 AND done_time IS NOT NULL AND qc_done_time IS NOT NULL
UNION ALL
SELECT 'v1_qc1_qc_pending'     AS metric, count() AS val FROM {{#${BASE_CARD}}} AS b WHERE version='v1' AND is_qc_on=1 AND done_time IS NOT NULL AND qc_done_time IS NULL
UNION ALL
SELECT 'v1_qc1_tech_pending'   AS metric, count() AS val FROM {{#${BASE_CARD}}} AS b WHERE version='v1' AND is_qc_on=1 AND done_time IS NULL
UNION ALL
SELECT 'v1_qc0_delivered'      AS metric, count() AS val FROM {{#${BASE_CARD}}} AS b WHERE version='v1' AND is_qc_on=0 AND done_time IS NOT NULL
UNION ALL
SELECT 'v1_qc0_tech_pending'   AS metric, count() AS val FROM {{#${BASE_CARD}}} AS b WHERE version='v1' AND is_qc_on=0 AND done_time IS NULL
UNION ALL
SELECT 'v2_qc0_delivered'      AS metric, count() AS val FROM {{#${BASE_CARD}}} AS b WHERE version='v2' AND is_qc_on=0 AND done_time IS NOT NULL
UNION ALL
SELECT 'v2_qc0_tech_pending'   AS metric, count() AS val FROM {{#${BASE_CARD}}} AS b WHERE version='v2' AND is_qc_on=0 AND done_time IS NULL
UNION ALL
SELECT 'v2_pub1_delivered'     AS metric, count() AS val FROM {{#${BASE_CARD}}} AS b WHERE version='v2' AND is_qc_on=1 AND is_publishing=1 AND firstPushedAt IS NOT NULL
UNION ALL
SELECT 'v2_pub1_pub_pending'   AS metric, count() AS val FROM {{#${BASE_CARD}}} AS b WHERE version='v2' AND is_qc_on=1 AND is_publishing=1 AND firstPushedAt IS NULL AND qc_done_time IS NOT NULL AND (now() - toDateTime(qc_done_time)) > 14400
UNION ALL
SELECT 'v2_pub1_to_push'       AS metric, count() AS val FROM {{#${BASE_CARD}}} AS b WHERE version='v2' AND is_qc_on=1 AND is_publishing=1 AND firstPushedAt IS NULL AND qc_done_time IS NOT NULL AND (now() - toDateTime(qc_done_time)) <= 14400
UNION ALL
SELECT 'v2_pub1_qc_pending'    AS metric, count() AS val FROM {{#${BASE_CARD}}} AS b WHERE version='v2' AND is_qc_on=1 AND is_publishing=1 AND qc_done_time IS NULL AND done_time IS NOT NULL
UNION ALL
SELECT 'v2_pub1_tech_pending'  AS metric, count() AS val FROM {{#${BASE_CARD}}} AS b WHERE version='v2' AND is_qc_on=1 AND is_publishing=1 AND done_time IS NULL
UNION ALL
SELECT 'v2_pub0_delivered'     AS metric, count() AS val FROM {{#${BASE_CARD}}} AS b WHERE version='v2' AND is_qc_on=1 AND is_publishing=0 AND qc_done_time IS NOT NULL
UNION ALL
SELECT 'v2_pub0_not_delivered' AS metric, count() AS val FROM {{#${BASE_CARD}}} AS b WHERE version='v2' AND is_qc_on=1 AND is_publishing=0 AND qc_done_time IS NULL AND done_time IS NOT NULL
UNION ALL
SELECT 'v2_pub0_tech_pending'  AS metric, count() AS val FROM {{#${BASE_CARD}}} AS b WHERE version='v2' AND is_qc_on=1 AND is_publishing=0 AND done_time IS NULL
`.trim();

// ── HTTP helper ───────────────────────────────────────────────────────────────
function mbQuery(sql) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      database: 350,
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

    const req = https.request({
      hostname: MB_HOST,
      path:     '/api/dataset',
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-api-key':      API_KEY,
      },
      timeout: 120_000,
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const data = JSON.parse(raw);
          if (data.error) return reject(new Error(`Metabase error: ${data.error}`));
          resolve(data?.data?.rows || []);
        } catch (e) {
          reject(new Error(`JSON parse error: ${e.message}\nRaw: ${raw.slice(0, 300)}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out after 120s')); });
    req.write(body);
    req.end();
  });
}

// ── MAIN ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`[${new Date().toISOString()}] Querying Metabase card #${BASE_CARD}…`);

  let rows;
  try {
    rows = await mbQuery(SQL);
  } catch (err) {
    console.error('Query failed:', err.message);
    process.exit(1);
  }

  // Build flat key→value object from rows: [[metric, val], ...]
  const counts = { updated_at: new Date().toISOString() };
  for (const [metric, val] of rows) {
    counts[metric] = Number(val);
  }

  console.log(`Got ${rows.length} metrics:`, counts);

  // Ensure output directory exists
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(counts, null, 2));
  console.log(`Written to ${OUT_FILE}`);
})();
