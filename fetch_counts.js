#!/usr/bin/env node
/**
 * fetch_counts.js — Metabase → data/counts.json
 * ================================================
 * Two-tier query strategy:
 *   1. PRIMARY  — GROUP BY with counts + enterprise + avg + P95 (one table scan)
 *   2. FALLBACK — same GROUP BY but only counts + enterprise (no timing)
 *                 runs if primary fails so counts always show
 *
 * Run by GitHub Actions hourly and on workflow_dispatch (Refresh button).
 * Local test:  MB_API_KEY=mb_... node fetch_counts.js
 */

'use strict';
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const MB_HOST   = 'metabase.spyne.ai';
const API_KEY   = process.env.MB_API_KEY;
const BASE_CARD = 12816;
const OUT_FILE  = path.join(__dirname, 'data', 'counts.json');

if (!API_KEY) {
  console.error('ERROR: MB_API_KEY not set.');
  process.exit(1);
}

const B = `{{#${BASE_CARD}}} AS b`;

// ── PRIMARY query — counts + enterprise + avg + P95 ───────────────────────────
// Uses avgIf + quantileIf (ClickHouse conditional aggregates).
// NOTE: only IS NULL / IS NOT NULL used for timestamp checks — no string comparisons.
const SQL_FULL = `
SELECT
  version,
  is_qc_on,
  is_publishing,

  -- Enterprise
  uniq(enterprise_name) AS ent_count,

  -- State counts
  countIf(done_time IS NULL)
    AS tech_pending,
  countIf(done_time IS NOT NULL AND qc_done_time IS NULL)
    AS done_no_qc,
  countIf(done_time IS NOT NULL AND qc_done_time IS NOT NULL AND firstPushedAt IS NULL)
    AS done_qc_no_push,
  countIf(firstPushedAt IS NOT NULL)
    AS pushed,
  countIf(firstPushedAt IS NULL AND qc_done_time IS NOT NULL
      AND (toUnixTimestamp(now()) - toUnixTimestamp(toDateTime(qc_done_time))) > 14400)
    AS waiting_push_long,
  countIf(firstPushedAt IS NULL AND qc_done_time IS NOT NULL
      AND (toUnixTimestamp(now()) - toUnixTimestamp(toDateTime(qc_done_time))) <= 14400)
    AS waiting_push_short,

  -- Tech processing: ai_sku_created_on → done_time
  round(avgIf(
    dateDiff('minute', toDateTime(ai_sku_created_on), toDateTime(done_time)),
    ai_sku_created_on IS NOT NULL AND done_time IS NOT NULL
  )) AS tech_avg_min,
  round(quantileIf(0.95)(
    dateDiff('minute', toDateTime(ai_sku_created_on), toDateTime(done_time)),
    ai_sku_created_on IS NOT NULL AND done_time IS NOT NULL
  )) AS tech_p95_min,

  -- QC review: done_time → qc_done_time
  round(avgIf(
    dateDiff('minute', toDateTime(done_time), toDateTime(qc_done_time)),
    done_time IS NOT NULL AND qc_done_time IS NOT NULL
  )) AS qc_avg_min,
  round(quantileIf(0.95)(
    dateDiff('minute', toDateTime(done_time), toDateTime(qc_done_time)),
    done_time IS NOT NULL AND qc_done_time IS NOT NULL
  )) AS qc_p95_min,

  -- Pre-processing: processedAt → ai_sku_created_on (v2 only)
  round(avgIf(
    dateDiff('minute', toDateTime(processedAt), toDateTime(ai_sku_created_on)),
    processedAt IS NOT NULL AND ai_sku_created_on IS NOT NULL
  )) AS pre_avg_min,
  round(quantileIf(0.95)(
    dateDiff('minute', toDateTime(processedAt), toDateTime(ai_sku_created_on)),
    processedAt IS NOT NULL AND ai_sku_created_on IS NOT NULL
  )) AS pre_p95_min,

  -- Publishing: qc_done_time → firstPushedAt (v2 pub only)
  round(avgIf(
    dateDiff('minute', toDateTime(qc_done_time), toDateTime(firstPushedAt)),
    qc_done_time IS NOT NULL AND firstPushedAt IS NOT NULL
  )) AS push_avg_min,
  round(quantileIf(0.95)(
    dateDiff('minute', toDateTime(qc_done_time), toDateTime(firstPushedAt)),
    qc_done_time IS NOT NULL AND firstPushedAt IS NOT NULL
  )) AS push_p95_min

FROM ${B}
WHERE version IS NOT NULL AND is_qc_on IS NOT NULL
GROUP BY version, is_qc_on, is_publishing
ORDER BY version DESC, is_qc_on DESC, is_publishing DESC
`;

// ── FALLBACK query — counts + enterprise only (no timing) ─────────────────────
// Runs if primary fails. Always works since it only uses countIf + uniq.
const SQL_COUNTS = `
SELECT
  version,
  is_qc_on,
  is_publishing,
  uniq(enterprise_name) AS ent_count,
  countIf(done_time IS NULL) AS tech_pending,
  countIf(done_time IS NOT NULL AND qc_done_time IS NULL) AS done_no_qc,
  countIf(done_time IS NOT NULL AND qc_done_time IS NOT NULL AND firstPushedAt IS NULL) AS done_qc_no_push,
  countIf(firstPushedAt IS NOT NULL) AS pushed,
  countIf(firstPushedAt IS NULL AND qc_done_time IS NOT NULL
      AND (toUnixTimestamp(now()) - toUnixTimestamp(toDateTime(qc_done_time))) > 14400) AS waiting_push_long,
  countIf(firstPushedAt IS NULL AND qc_done_time IS NOT NULL
      AND (toUnixTimestamp(now()) - toUnixTimestamp(toDateTime(qc_done_time))) <= 14400) AS waiting_push_short
FROM ${B}
WHERE version IS NOT NULL AND is_qc_on IS NOT NULL
GROUP BY version, is_qc_on, is_publishing
ORDER BY version DESC, is_qc_on DESC, is_publishing DESC
`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Metabase API ──────────────────────────────────────────────────────────────
function mbRun(sql, retries = 3) {
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
        timeout: 180_000,
      }, res => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => {
          try {
            const d = JSON.parse(raw);
            if (d.error) {
              if (n > 1 && d.error.includes('MEMORY_LIMIT')) {
                console.warn(`  Memory limit, retrying in 15s… (${n-1} left)`);
                return sleep(15_000).then(() => attempt(n - 1));
              }
              return reject(new Error(d.error));
            }
            if (!d?.data?.rows?.length) return reject(new Error('Query returned 0 rows'));
            resolve(d);
          } catch (e) { reject(new Error(`Parse error: ${e.message}`)); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout after 180s')); });
      req.write(body);
      req.end();
    };
    attempt(retries);
  });
}

// ── Map rows → flat counts object ─────────────────────────────────────────────
function mapRows(apiData) {
  const colNames = apiData.data.cols.map(c => c.name);
  const idx      = name => colNames.indexOf(name);
  const rows     = apiData.data.rows;
  const counts   = {};

  console.log(`  Columns (${colNames.length}): ${colNames.join(', ')}`);
  console.log(`  Rows: ${rows.length}`);

  for (const row of rows) {
    const str = name => { const i = idx(name); return i < 0 ? null : (row[i] == null ? null : String(row[i])); };
    const num = name => { const i = idx(name); return i < 0 ? null : (row[i] == null ? null : Number(row[i])); };

    const version      = str('version');
    const is_qc_on     = num('is_qc_on');
    const is_publishing = num('is_publishing');

    const techPending  = num('tech_pending');
    const doneNoQc     = num('done_no_qc');
    const doneQcNoPush = num('done_qc_no_push');
    const pushed       = num('pushed');
    const waitLong     = num('waiting_push_long');
    const waitShort    = num('waiting_push_short');
    const entCount     = num('ent_count');

    // Timing (only present in full query; null in fallback query)
    const techAvg  = num('tech_avg_min');
    const techP95  = num('tech_p95_min');
    const qcAvg    = num('qc_avg_min');
    const qcP95    = num('qc_p95_min');
    const preAvg   = num('pre_avg_min');
    const preP95   = num('pre_p95_min');
    const pushAvg  = num('push_avg_min');
    const pushP95  = num('push_p95_min');

    console.log(`  Seg: v=${version} qc=${is_qc_on} pub=${is_publishing}  tech_pending=${techPending}  ent=${entCount}  tech_avg=${techAvg}`);

    if (version === 'v1' && is_qc_on === 1) {
      Object.assign(counts, {
        v1_qc1_delivered:    doneQcNoPush,
        v1_qc1_qc_pending:   doneNoQc,
        v1_qc1_tech_pending: techPending,
        v1_qc1_ent_count:    entCount,
        v1_qc1_tech_avg_min: techAvg,  v1_qc1_tech_p95_min: techP95,
        v1_qc1_qc_avg_min:   qcAvg,    v1_qc1_qc_p95_min:   qcP95,
      });

    } else if (version === 'v1' && is_qc_on === 0) {
      Object.assign(counts, {
        v1_qc0_delivered:    doneNoQc,
        v1_qc0_tech_pending: techPending,
        v1_qc0_ent_count:    entCount,
        v1_qc0_tech_avg_min: techAvg,  v1_qc0_tech_p95_min: techP95,
      });

    } else if (version === 'v2' && is_qc_on === 0) {
      Object.assign(counts, {
        v2_qc0_delivered:    doneNoQc,
        v2_qc0_tech_pending: techPending,
        v2_qc0_ent_count:    entCount,
        v2_qc0_pre_avg_min:  preAvg,   v2_qc0_pre_p95_min:  preP95,
        v2_qc0_tech_avg_min: techAvg,  v2_qc0_tech_p95_min: techP95,
      });

    } else if (version === 'v2' && is_qc_on === 1 && is_publishing === 1) {
      Object.assign(counts, {
        v2_pub1_delivered:    pushed,
        v2_pub1_pub_pending:  waitLong,
        v2_pub1_to_push:      waitShort,
        v2_pub1_qc_pending:   doneNoQc,
        v2_pub1_tech_pending: techPending,
        v2_pub1_ent_count:    entCount,
        v2_pub1_pre_avg_min:  preAvg,   v2_pub1_pre_p95_min:  preP95,
        v2_pub1_tech_avg_min: techAvg,  v2_pub1_tech_p95_min: techP95,
        v2_pub1_qc_avg_min:   qcAvg,    v2_pub1_qc_p95_min:   qcP95,
        v2_pub1_push_avg_min: pushAvg,  v2_pub1_push_p95_min: pushP95,
      });

    } else if (version === 'v2' && is_qc_on === 1 && is_publishing !== 1) {
      Object.assign(counts, {
        v2_pub0_delivered:     doneQcNoPush,
        v2_pub0_not_delivered: doneNoQc,
        v2_pub0_tech_pending:  techPending,
        v2_pub0_ent_count:     entCount,
        v2_pub0_pre_avg_min:   preAvg,   v2_pub0_pre_p95_min:  preP95,
        v2_pub0_tech_avg_min:  techAvg,  v2_pub0_tech_p95_min: techP95,
        v2_pub0_qc_avg_min:    qcAvg,    v2_pub0_qc_p95_min:   qcP95,
      });

    } else {
      console.log(`  ⚠ Unknown segment — skipped.`);
    }
  }
  return counts;
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
(async () => {
  const startTime = Date.now();
  console.log(`[${new Date().toISOString()}] Starting…`);

  let existing = {};
  try {
    existing = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
    console.log('Loaded existing counts.json — preserving on failure.');
  } catch { console.log('No existing counts.json.'); }

  const counts = { updated_at: new Date().toISOString() };
  let usedFallback = false;

  // ── Try primary query (full data with timing) ────────────────────────────
  console.log('\n[1/2] Running primary query (counts + enterprise + avg + P95)…');
  try {
    const data   = await mbRun(SQL_FULL);
    const mapped = mapRows(data);
    Object.assign(counts, mapped);
    console.log(`✓ Primary succeeded (${Object.keys(mapped).length} keys, ${((Date.now()-startTime)/1000).toFixed(1)}s)`);

  } catch (err) {
    console.error(`✗ Primary failed: ${err.message}`);
    console.log('\n[2/2] Running fallback query (counts + enterprise only)…');
    usedFallback = true;
    try {
      const data   = await mbRun(SQL_COUNTS);
      const mapped = mapRows(data);
      // Preserve existing timing values from last successful full run
      const timingKeys = Object.keys(existing).filter(k =>
        k.endsWith('_avg_min') || k.endsWith('_p95_min')
      );
      timingKeys.forEach(k => { if (existing[k] != null) counts[k] = existing[k]; });
      Object.assign(counts, mapped);
      console.log(`✓ Fallback succeeded (${Object.keys(mapped).length} keys, ${((Date.now()-startTime)/1000).toFixed(1)}s)`);

    } catch (err2) {
      console.error(`✗ Fallback also failed: ${err2.message}`);
      // Preserve everything from last run
      Object.assign(counts, existing);
      counts.updated_at = existing.updated_at ?? counts.updated_at;
      console.warn('Using fully preserved existing values.');
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsed}s${usedFallback ? ' (fallback mode — timing from cache)' : ''}.`);

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(counts, null, 2));
  console.log(`Written → ${OUT_FILE}`);
})();
