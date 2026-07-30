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

// ── Aggregate queries: enterprise count + timing per segment ──────────────────
// Each returns one row with multiple columns; col order matches keys[] below.
const AGGREGATE_QUERIES = [
  {
    // SEG 1: v1, QC On — tech processing + qc review times
    keys: ['v1_qc1_ent_count', 'v1_qc1_tech_avg_min', 'v1_qc1_tech_p95_min', 'v1_qc1_qc_avg_min', 'v1_qc1_qc_p95_min'],
    where: `version='v1' AND is_qc_on=1 AND done_time IS NOT NULL AND qc_done_time IS NOT NULL`,
    select: [
      `toInt64(uniq(enterprise_name))`,
      `round(avg(dateDiff('minute', toDateTime(ai_sku_created_on), toDateTime(done_time))))`,
      `round(quantile(0.95)(dateDiff('minute', toDateTime(ai_sku_created_on), toDateTime(done_time))))`,
      `round(avg(dateDiff('minute', toDateTime(done_time), toDateTime(qc_done_time))))`,
      `round(quantile(0.95)(dateDiff('minute', toDateTime(done_time), toDateTime(qc_done_time))))`,
    ],
  },
  {
    // SEG 2: v1, QC Off — tech processing time only
    keys: ['v1_qc0_ent_count', 'v1_qc0_tech_avg_min', 'v1_qc0_tech_p95_min'],
    where: `version='v1' AND is_qc_on=0 AND done_time IS NOT NULL`,
    select: [
      `toInt64(uniq(enterprise_name))`,
      `round(avg(dateDiff('minute', toDateTime(ai_sku_created_on), toDateTime(done_time))))`,
      `round(quantile(0.95)(dateDiff('minute', toDateTime(ai_sku_created_on), toDateTime(done_time))))`,
    ],
  },
  {
    // SEG 3: v2, QC Off — pre-processing + tech processing
    keys: ['v2_qc0_ent_count', 'v2_qc0_pre_avg_min', 'v2_qc0_pre_p95_min', 'v2_qc0_tech_avg_min', 'v2_qc0_tech_p95_min'],
    where: `version='v2' AND is_qc_on=0 AND processedAt IS NOT NULL AND ai_sku_created_on IS NOT NULL AND done_time IS NOT NULL`,
    select: [
      `toInt64(uniq(enterprise_name))`,
      `round(avg(dateDiff('minute', toDateTime(processedAt), toDateTime(ai_sku_created_on))))`,
      `round(quantile(0.95)(dateDiff('minute', toDateTime(processedAt), toDateTime(ai_sku_created_on))))`,
      `round(avg(dateDiff('minute', toDateTime(ai_sku_created_on), toDateTime(done_time))))`,
      `round(quantile(0.95)(dateDiff('minute', toDateTime(ai_sku_created_on), toDateTime(done_time))))`,
    ],
  },
  {
    // SEG 4: v2, QC On, Publishing — full 4-stage pipeline
    keys: [
      'v2_pub1_ent_count',
      'v2_pub1_pre_avg_min', 'v2_pub1_pre_p95_min',
      'v2_pub1_tech_avg_min', 'v2_pub1_tech_p95_min',
      'v2_pub1_qc_avg_min', 'v2_pub1_qc_p95_min',
      'v2_pub1_push_avg_min', 'v2_pub1_push_p95_min',
    ],
    where: `version='v2' AND is_qc_on=1 AND is_publishing=1 AND processedAt IS NOT NULL AND done_time IS NOT NULL AND qc_done_time IS NOT NULL AND firstPushedAt IS NOT NULL`,
    select: [
      `toInt64(uniq(enterprise_name))`,
      `round(avg(dateDiff('minute', toDateTime(processedAt), toDateTime(ai_sku_created_on))))`,
      `round(quantile(0.95)(dateDiff('minute', toDateTime(processedAt), toDateTime(ai_sku_created_on))))`,
      `round(avg(dateDiff('minute', toDateTime(ai_sku_created_on), toDateTime(done_time))))`,
      `round(quantile(0.95)(dateDiff('minute', toDateTime(ai_sku_created_on), toDateTime(done_time))))`,
      `round(avg(dateDiff('minute', toDateTime(done_time), toDateTime(qc_done_time))))`,
      `round(quantile(0.95)(dateDiff('minute', toDateTime(done_time), toDateTime(qc_done_time))))`,
      `round(avg(dateDiff('minute', toDateTime(qc_done_time), toDateTime(firstPushedAt))))`,
      `round(quantile(0.95)(dateDiff('minute', toDateTime(qc_done_time), toDateTime(firstPushedAt))))`,
    ],
  },
  {
    // SEG 5: v2, QC On, No Publishing — pre-processing + tech + qc
    keys: [
      'v2_pub0_ent_count',
      'v2_pub0_pre_avg_min', 'v2_pub0_pre_p95_min',
      'v2_pub0_tech_avg_min', 'v2_pub0_tech_p95_min',
      'v2_pub0_qc_avg_min', 'v2_pub0_qc_p95_min',
    ],
    where: `version='v2' AND is_qc_on=1 AND is_publishing=0 AND processedAt IS NOT NULL AND done_time IS NOT NULL AND qc_done_time IS NOT NULL`,
    select: [
      `toInt64(uniq(enterprise_name))`,
      `round(avg(dateDiff('minute', toDateTime(processedAt), toDateTime(ai_sku_created_on))))`,
      `round(quantile(0.95)(dateDiff('minute', toDateTime(processedAt), toDateTime(ai_sku_created_on))))`,
      `round(avg(dateDiff('minute', toDateTime(ai_sku_created_on), toDateTime(done_time))))`,
      `round(quantile(0.95)(dateDiff('minute', toDateTime(ai_sku_created_on), toDateTime(done_time))))`,
      `round(avg(dateDiff('minute', toDateTime(done_time), toDateTime(qc_done_time))))`,
      `round(quantile(0.95)(dateDiff('minute', toDateTime(done_time), toDateTime(qc_done_time))))`,
    ],
  },
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

// ── Multi-column aggregate helper ────────────────────────────────────────────
function mbAggregate(selectCols, where, retries = 3) {
  const sql = `SELECT ${selectCols.join(', ')} FROM {{#${BASE_CARD}}} AS b WHERE ${where}`;
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
            const row = data?.data?.rows?.[0] ?? [];
            resolve(row.map(v => (v === null ? null : Number(v))));
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

  // Load existing counts so we can preserve values on query failure
  let existing = {};
  try {
    existing = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
    console.log('Loaded existing counts.json — will preserve values on failure.');
  } catch {
    console.log('No existing counts.json — starting fresh.');
  }

  const counts = { updated_at: new Date().toISOString() };
  let failures = 0;

  for (const [metric, where] of QUERIES) {
    process.stdout.write(`  ${metric}… `);
    try {
      const val = await mbCount(where);
      counts[metric] = val;
      console.log(val.toLocaleString());
    } catch (err) {
      failures++;
      // Keep the last known good value instead of writing null
      counts[metric] = existing[metric] ?? null;
      console.error(`FAILED (kept previous: ${counts[metric]}) — ${err.message.slice(0, 120)}`);
    }
    await sleep(2_000);
  }

  // Only update updated_at if at least some queries succeeded
  if (failures === QUERIES.length) {
    counts.updated_at = existing.updated_at ?? counts.updated_at;
    console.warn('All queries failed — preserving previous updated_at timestamp.');
  }

  // ── AGGREGATE QUERIES (enterprise count + avg/P95 timing) ──────────────────
  console.log(`\nFetching ${AGGREGATE_QUERIES.length} aggregate queries (enterprise count + timing)…`);
  let aggFailures = 0;

  for (const { keys, select, where } of AGGREGATE_QUERIES) {
    const label = keys[0].replace('_ent_count', '');
    process.stdout.write(`  ${label}… `);
    try {
      const vals = await mbAggregate(select, where);
      keys.forEach((k, i) => { counts[k] = vals[i] ?? null; });
      console.log(keys.map((k, i) => `${k.split('_').slice(-2).join('_')}=${vals[i]}`).join(' '));
    } catch (err) {
      aggFailures++;
      keys.forEach(k => { counts[k] = existing[k] ?? null; });
      console.error(`FAILED (kept previous) — ${err.message.slice(0, 120)}`);
    }
    await sleep(2_000);
  }
  console.log(`Aggregates: ${AGGREGATE_QUERIES.length - aggFailures}/${AGGREGATE_QUERIES.length} succeeded.`);

  console.log(`\nDone. Counts: ${QUERIES.length - failures}/${QUERIES.length} · Aggregates: ${AGGREGATE_QUERIES.length - aggFailures}/${AGGREGATE_QUERIES.length}`);
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(counts, null, 2));
  console.log(`Written → ${OUT_FILE}`);
})();
