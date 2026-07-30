#!/usr/bin/env node
/**
 * fetch_counts.js — Metabase → data/counts.json
 * ================================================
 * Run by GitHub Actions every hour (see .github/workflows/refresh-data.yml).
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
const MB_HOST   = 'metabase.spyne.ai';
const API_KEY   = process.env.MB_API_KEY;
const BASE_CARD = 12816;  // _SKU Journey Base v2 (is_360=0, all statuses)
const OUT_FILE  = path.join(__dirname, 'data', 'counts.json');
// ─────────────────────────────────────────────────────────────────────────────

if (!API_KEY) {
  console.error('ERROR: MB_API_KEY environment variable is not set.');
  process.exit(1);
}

// ── COUNT QUERIES ─────────────────────────────────────────────────────────────
// Pattern: SELECT count() FROM {{#12816}} AS b WHERE <where>
const COUNT_QUERIES = [
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

// ── SCALAR QUERIES ────────────────────────────────────────────────────────────
// Pattern: full SQL returning a single scalar value.
// Each query runs individually (no UNION ALL — avoids ClickHouse memory limits).
const C = `{{#${BASE_CARD}}} AS b`;  // shorthand alias

const SCALAR_QUERIES = [
  // ── Enterprise counts (uniq per segment) ──
  ['v1_qc1_ent_count',     `SELECT uniq(enterprise_name) FROM ${C} WHERE version='v1' AND is_qc_on=1`],
  ['v1_qc0_ent_count',     `SELECT uniq(enterprise_name) FROM ${C} WHERE version='v1' AND is_qc_on=0`],
  ['v2_qc0_ent_count',     `SELECT uniq(enterprise_name) FROM ${C} WHERE version='v2' AND is_qc_on=0`],
  ['v2_pub1_ent_count',    `SELECT uniq(enterprise_name) FROM ${C} WHERE version='v2' AND is_qc_on=1 AND is_publishing=1`],
  ['v2_pub0_ent_count',    `SELECT uniq(enterprise_name) FROM ${C} WHERE version='v2' AND is_qc_on=1 AND is_publishing=0`],

  // ── v1 · QC On — tech processing (ai_sku_created_on → done_time) ──
  ['v1_qc1_tech_avg_min',  `SELECT round(avg(dateDiff('minute', toDateTime(ai_sku_created_on), toDateTime(done_time)))) FROM ${C} WHERE version='v1' AND is_qc_on=1 AND ai_sku_created_on IS NOT NULL AND done_time IS NOT NULL`],
  ['v1_qc1_tech_p95_min',  `SELECT round(quantile(0.95)(dateDiff('minute', toDateTime(ai_sku_created_on), toDateTime(done_time)))) FROM ${C} WHERE version='v1' AND is_qc_on=1 AND ai_sku_created_on IS NOT NULL AND done_time IS NOT NULL`],
  // ── v1 · QC On — QC review (done_time → qc_done_time) ──
  ['v1_qc1_qc_avg_min',    `SELECT round(avg(dateDiff('minute', toDateTime(done_time), toDateTime(qc_done_time)))) FROM ${C} WHERE version='v1' AND is_qc_on=1 AND done_time IS NOT NULL AND qc_done_time IS NOT NULL`],
  ['v1_qc1_qc_p95_min',    `SELECT round(quantile(0.95)(dateDiff('minute', toDateTime(done_time), toDateTime(qc_done_time)))) FROM ${C} WHERE version='v1' AND is_qc_on=1 AND done_time IS NOT NULL AND qc_done_time IS NOT NULL`],

  // ── v1 · QC Off — tech processing (ai_sku_created_on → done_time) ──
  ['v1_qc0_tech_avg_min',  `SELECT round(avg(dateDiff('minute', toDateTime(ai_sku_created_on), toDateTime(done_time)))) FROM ${C} WHERE version='v1' AND is_qc_on=0 AND ai_sku_created_on IS NOT NULL AND done_time IS NOT NULL`],
  ['v1_qc0_tech_p95_min',  `SELECT round(quantile(0.95)(dateDiff('minute', toDateTime(ai_sku_created_on), toDateTime(done_time)))) FROM ${C} WHERE version='v1' AND is_qc_on=0 AND ai_sku_created_on IS NOT NULL AND done_time IS NOT NULL`],

  // ── v2 · QC Off — pre-processing (processedAt → ai_sku_created_on) ──
  ['v2_qc0_pre_avg_min',   `SELECT round(avg(dateDiff('minute', toDateTime(processedAt), toDateTime(ai_sku_created_on)))) FROM ${C} WHERE version='v2' AND is_qc_on=0 AND processedAt IS NOT NULL AND ai_sku_created_on IS NOT NULL`],
  ['v2_qc0_pre_p95_min',   `SELECT round(quantile(0.95)(dateDiff('minute', toDateTime(processedAt), toDateTime(ai_sku_created_on)))) FROM ${C} WHERE version='v2' AND is_qc_on=0 AND processedAt IS NOT NULL AND ai_sku_created_on IS NOT NULL`],
  // ── v2 · QC Off — tech processing (ai_sku_created_on → done_time) ──
  ['v2_qc0_tech_avg_min',  `SELECT round(avg(dateDiff('minute', toDateTime(ai_sku_created_on), toDateTime(done_time)))) FROM ${C} WHERE version='v2' AND is_qc_on=0 AND ai_sku_created_on IS NOT NULL AND done_time IS NOT NULL`],
  ['v2_qc0_tech_p95_min',  `SELECT round(quantile(0.95)(dateDiff('minute', toDateTime(ai_sku_created_on), toDateTime(done_time)))) FROM ${C} WHERE version='v2' AND is_qc_on=0 AND ai_sku_created_on IS NOT NULL AND done_time IS NOT NULL`],

  // ── v2 · QC On · Publishing — pre-processing ──
  ['v2_pub1_pre_avg_min',  `SELECT round(avg(dateDiff('minute', toDateTime(processedAt), toDateTime(ai_sku_created_on)))) FROM ${C} WHERE version='v2' AND is_qc_on=1 AND is_publishing=1 AND processedAt IS NOT NULL AND ai_sku_created_on IS NOT NULL`],
  ['v2_pub1_pre_p95_min',  `SELECT round(quantile(0.95)(dateDiff('minute', toDateTime(processedAt), toDateTime(ai_sku_created_on)))) FROM ${C} WHERE version='v2' AND is_qc_on=1 AND is_publishing=1 AND processedAt IS NOT NULL AND ai_sku_created_on IS NOT NULL`],
  // ── v2 · QC On · Publishing — tech processing ──
  ['v2_pub1_tech_avg_min', `SELECT round(avg(dateDiff('minute', toDateTime(ai_sku_created_on), toDateTime(done_time)))) FROM ${C} WHERE version='v2' AND is_qc_on=1 AND is_publishing=1 AND ai_sku_created_on IS NOT NULL AND done_time IS NOT NULL`],
  ['v2_pub1_tech_p95_min', `SELECT round(quantile(0.95)(dateDiff('minute', toDateTime(ai_sku_created_on), toDateTime(done_time)))) FROM ${C} WHERE version='v2' AND is_qc_on=1 AND is_publishing=1 AND ai_sku_created_on IS NOT NULL AND done_time IS NOT NULL`],
  // ── v2 · QC On · Publishing — QC review ──
  ['v2_pub1_qc_avg_min',   `SELECT round(avg(dateDiff('minute', toDateTime(done_time), toDateTime(qc_done_time)))) FROM ${C} WHERE version='v2' AND is_qc_on=1 AND is_publishing=1 AND done_time IS NOT NULL AND qc_done_time IS NOT NULL`],
  ['v2_pub1_qc_p95_min',   `SELECT round(quantile(0.95)(dateDiff('minute', toDateTime(done_time), toDateTime(qc_done_time)))) FROM ${C} WHERE version='v2' AND is_qc_on=1 AND is_publishing=1 AND done_time IS NOT NULL AND qc_done_time IS NOT NULL`],
  // ── v2 · QC On · Publishing — publishing (qc_done_time → firstPushedAt) ──
  ['v2_pub1_push_avg_min', `SELECT round(avg(dateDiff('minute', toDateTime(qc_done_time), toDateTime(firstPushedAt)))) FROM ${C} WHERE version='v2' AND is_qc_on=1 AND is_publishing=1 AND qc_done_time IS NOT NULL AND firstPushedAt IS NOT NULL`],
  ['v2_pub1_push_p95_min', `SELECT round(quantile(0.95)(dateDiff('minute', toDateTime(qc_done_time), toDateTime(firstPushedAt)))) FROM ${C} WHERE version='v2' AND is_qc_on=1 AND is_publishing=1 AND qc_done_time IS NOT NULL AND firstPushedAt IS NOT NULL`],

  // ── v2 · QC On · No Publishing — pre-processing ──
  ['v2_pub0_pre_avg_min',  `SELECT round(avg(dateDiff('minute', toDateTime(processedAt), toDateTime(ai_sku_created_on)))) FROM ${C} WHERE version='v2' AND is_qc_on=1 AND is_publishing=0 AND processedAt IS NOT NULL AND ai_sku_created_on IS NOT NULL`],
  ['v2_pub0_pre_p95_min',  `SELECT round(quantile(0.95)(dateDiff('minute', toDateTime(processedAt), toDateTime(ai_sku_created_on)))) FROM ${C} WHERE version='v2' AND is_qc_on=1 AND is_publishing=0 AND processedAt IS NOT NULL AND ai_sku_created_on IS NOT NULL`],
  // ── v2 · QC On · No Publishing — tech processing ──
  ['v2_pub0_tech_avg_min', `SELECT round(avg(dateDiff('minute', toDateTime(ai_sku_created_on), toDateTime(done_time)))) FROM ${C} WHERE version='v2' AND is_qc_on=1 AND is_publishing=0 AND ai_sku_created_on IS NOT NULL AND done_time IS NOT NULL`],
  ['v2_pub0_tech_p95_min', `SELECT round(quantile(0.95)(dateDiff('minute', toDateTime(ai_sku_created_on), toDateTime(done_time)))) FROM ${C} WHERE version='v2' AND is_qc_on=1 AND is_publishing=0 AND ai_sku_created_on IS NOT NULL AND done_time IS NOT NULL`],
  // ── v2 · QC On · No Publishing — QC review ──
  ['v2_pub0_qc_avg_min',   `SELECT round(avg(dateDiff('minute', toDateTime(done_time), toDateTime(qc_done_time)))) FROM ${C} WHERE version='v2' AND is_qc_on=1 AND is_publishing=0 AND done_time IS NOT NULL AND qc_done_time IS NOT NULL`],
  ['v2_pub0_qc_p95_min',   `SELECT round(quantile(0.95)(dateDiff('minute', toDateTime(done_time), toDateTime(qc_done_time)))) FROM ${C} WHERE version='v2' AND is_qc_on=1 AND is_publishing=0 AND done_time IS NOT NULL AND qc_done_time IS NOT NULL`],
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Metabase API helper ───────────────────────────────────────────────────────
// Runs any SQL that references {{#BASE_CARD}} and returns rows[0][0] as Number.
function mbQuery(sql, retries = 3) {
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
                console.warn(`  Memory limit, retrying in 10s… (${n-1} left)`);
                return sleep(10_000).then(() => attempt(n - 1));
              }
              return reject(new Error(data.error));
            }
            const val = data?.data?.rows?.[0]?.[0];
            resolve(val === null || val === undefined ? null : Number(val));
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
  const total = COUNT_QUERIES.length + SCALAR_QUERIES.length;
  console.log(`[${new Date().toISOString()}] Running ${total} queries (${COUNT_QUERIES.length} counts + ${SCALAR_QUERIES.length} scalars)…`);

  // Load existing data to preserve values on query failure
  let existing = {};
  try {
    existing = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
    console.log('Loaded existing counts.json — will preserve values on failure.');
  } catch {
    console.log('No existing counts.json — starting fresh.');
  }

  const counts = { updated_at: new Date().toISOString() };
  let failures = 0;

  // ── Phase 1: count queries ──────────────────────────────────────────────────
  console.log(`\n[Phase 1] Count queries…`);
  for (const [metric, where] of COUNT_QUERIES) {
    process.stdout.write(`  ${metric}… `);
    try {
      const val = await mbQuery(`SELECT count() FROM ${C} WHERE ${where}`);
      counts[metric] = val;
      console.log((val ?? 0).toLocaleString());
    } catch (err) {
      failures++;
      counts[metric] = existing[metric] ?? null;
      console.error(`FAILED (kept: ${counts[metric]}) — ${err.message.slice(0, 100)}`);
    }
    await sleep(2_000);
  }

  // Only advance updated_at if at least one count succeeded
  if (failures === COUNT_QUERIES.length) {
    counts.updated_at = existing.updated_at ?? counts.updated_at;
    console.warn('All count queries failed — preserving previous timestamp.');
  }

  // ── Phase 2: scalar queries (enterprise counts + timing) ───────────────────
  console.log(`\n[Phase 2] Scalar queries (enterprise counts + avg/P95 timing)…`);
  let scalarFailures = 0;

  for (const [metric, sql] of SCALAR_QUERIES) {
    process.stdout.write(`  ${metric}… `);
    try {
      const val = await mbQuery(sql);
      counts[metric] = val;
      console.log(val ?? '—');
    } catch (err) {
      scalarFailures++;
      counts[metric] = existing[metric] ?? null;
      console.error(`FAILED (kept: ${counts[metric]}) — ${err.message.slice(0, 100)}`);
    }
    await sleep(2_000);
  }

  const ok1 = COUNT_QUERIES.length - failures;
  const ok2 = SCALAR_QUERIES.length - scalarFailures;
  console.log(`\nDone. Counts: ${ok1}/${COUNT_QUERIES.length} · Scalars: ${ok2}/${SCALAR_QUERIES.length}`);

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(counts, null, 2));
  console.log(`Written → ${OUT_FILE}`);
})();
