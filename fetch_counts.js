#!/usr/bin/env node
/**
 * fetch_counts.js — Metabase → data/counts.json
 * ================================================
 * ONE GROUP BY query fetches all counts + enterprise counts + timing in a single
 * table scan. ~5 rows returned, parsed in JS and mapped to counts.json keys.
 *
 * Run by GitHub Actions every hour (and on-demand via workflow_dispatch).
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
  console.error('ERROR: MB_API_KEY environment variable is not set.');
  process.exit(1);
}

// ── Single query — one scan, all segments, all metrics ────────────────────────
// Returns ~5 rows (one per segment): v1/qc1, v1/qc0, v2/qc0, v2/pub1, v2/pub0
const SQL = `
SELECT
  version,
  is_qc_on,
  is_publishing,

  -- Enterprise count
  uniq(enterprise_name)                                    AS ent_count,

  -- State counts
  countIf(done_time IS NULL)                               AS tech_pending,
  countIf(done_time IS NOT NULL AND qc_done_time IS NULL)  AS done_no_qc,
  countIf(done_time IS NOT NULL AND qc_done_time IS NOT NULL AND (firstPushedAt IS NULL OR firstPushedAt = '')) AS done_qc_no_push,
  countIf(firstPushedAt IS NOT NULL AND firstPushedAt != '')                                                   AS pushed,
  countIf(firstPushedAt IS NULL AND qc_done_time IS NOT NULL
    AND dateDiff('second', toDateTime(qc_done_time), now()) > 14400)                                           AS waiting_push_long,
  countIf(firstPushedAt IS NULL AND qc_done_time IS NOT NULL
    AND dateDiff('second', toDateTime(qc_done_time), now()) <= 14400)                                          AS waiting_push_short,

  -- Tech processing: ai_sku_created_on → done_time
  round(avgIf(
    dateDiff('minute', toDateTime(ai_sku_created_on), toDateTime(done_time)),
    ai_sku_created_on IS NOT NULL AND done_time IS NOT NULL
  ))                                                       AS tech_avg_min,
  round(quantileIf(0.95)(
    dateDiff('minute', toDateTime(ai_sku_created_on), toDateTime(done_time)),
    ai_sku_created_on IS NOT NULL AND done_time IS NOT NULL
  ))                                                       AS tech_p95_min,

  -- QC review: done_time → qc_done_time
  round(avgIf(
    dateDiff('minute', toDateTime(done_time), toDateTime(qc_done_time)),
    done_time IS NOT NULL AND qc_done_time IS NOT NULL
  ))                                                       AS qc_avg_min,
  round(quantileIf(0.95)(
    dateDiff('minute', toDateTime(done_time), toDateTime(qc_done_time)),
    done_time IS NOT NULL AND qc_done_time IS NOT NULL
  ))                                                       AS qc_p95_min,

  -- Pre-processing: processedAt → ai_sku_created_on (v2 only)
  round(avgIf(
    dateDiff('minute', toDateTime(processedAt), toDateTime(ai_sku_created_on)),
    processedAt IS NOT NULL AND ai_sku_created_on IS NOT NULL
  ))                                                       AS pre_avg_min,
  round(quantileIf(0.95)(
    dateDiff('minute', toDateTime(processedAt), toDateTime(ai_sku_created_on)),
    processedAt IS NOT NULL AND ai_sku_created_on IS NOT NULL
  ))                                                       AS pre_p95_min,

  -- Publishing: qc_done_time → firstPushedAt (v2 pub only)
  round(avgIf(
    dateDiff('minute', toDateTime(qc_done_time), toDateTime(firstPushedAt)),
    qc_done_time IS NOT NULL AND firstPushedAt IS NOT NULL AND firstPushedAt != ''
  ))                                                       AS push_avg_min,
  round(quantileIf(0.95)(
    dateDiff('minute', toDateTime(qc_done_time), toDateTime(firstPushedAt)),
    qc_done_time IS NOT NULL AND firstPushedAt IS NOT NULL AND firstPushedAt != ''
  ))                                                       AS push_p95_min

FROM {{#${BASE_CARD}}} AS b
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

// ── Map response rows → flat counts object ────────────────────────────────────
function mapRows(apiData) {
  const colNames = apiData.data.cols.map(c => c.name);
  const idx      = name => colNames.indexOf(name);
  const rows     = apiData.data.rows;
  const counts   = {};

  console.log(`  Columns: ${colNames.join(', ')}`);
  console.log(`  Rows received: ${rows.length}`);

  for (const row of rows) {
    const str = name => { const v = row[idx(name)]; return v == null ? null : String(v); };
    const num = name => { const v = row[idx(name)]; return v == null ? null : Number(v); };

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
    const techAvg      = num('tech_avg_min');
    const techP95      = num('tech_p95_min');
    const qcAvg        = num('qc_avg_min');
    const qcP95        = num('qc_p95_min');
    const preAvg       = num('pre_avg_min');
    const preP95       = num('pre_p95_min');
    const pushAvg      = num('push_avg_min');
    const pushP95      = num('push_p95_min');

    console.log(`  Row: version=${version} is_qc_on=${is_qc_on} is_publishing=${is_publishing} tech_pending=${techPending}`);

    if (version === 'v1' && is_qc_on === 1) {
      // SEG 1: v1 · QC On
      Object.assign(counts, {
        v1_qc1_delivered:    doneQcNoPush,
        v1_qc1_qc_pending:   doneNoQc,
        v1_qc1_tech_pending: techPending,
        v1_qc1_ent_count:    entCount,
        v1_qc1_tech_avg_min: techAvg,  v1_qc1_tech_p95_min: techP95,
        v1_qc1_qc_avg_min:   qcAvg,    v1_qc1_qc_p95_min:   qcP95,
      });

    } else if (version === 'v1' && is_qc_on === 0) {
      // SEG 2: v1 · QC Off (qc_done_time always NULL for this segment)
      Object.assign(counts, {
        v1_qc0_delivered:    doneNoQc,
        v1_qc0_tech_pending: techPending,
        v1_qc0_ent_count:    entCount,
        v1_qc0_tech_avg_min: techAvg,  v1_qc0_tech_p95_min: techP95,
      });

    } else if (version === 'v2' && is_qc_on === 0) {
      // SEG 3: v2 · QC Off
      Object.assign(counts, {
        v2_qc0_delivered:    doneNoQc,
        v2_qc0_tech_pending: techPending,
        v2_qc0_ent_count:    entCount,
        v2_qc0_pre_avg_min:  preAvg,   v2_qc0_pre_p95_min:  preP95,
        v2_qc0_tech_avg_min: techAvg,  v2_qc0_tech_p95_min: techP95,
      });

    } else if (version === 'v2' && is_qc_on === 1 && is_publishing === 1) {
      // SEG 4: v2 · QC On · Publishing
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
      // SEG 5: v2 · QC On · No Publishing (is_publishing = 0 or null)
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
      console.log(`  ⚠ Unknown segment row — skipped.`);
    }
  }

  return counts;
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`[${new Date().toISOString()}] Running single GROUP BY query against card #${BASE_CARD}…`);

  let existing = {};
  try {
    existing = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
    console.log('Loaded existing counts.json — preserving on failure.');
  } catch {
    console.log('No existing counts.json.');
  }

  let counts = { updated_at: new Date().toISOString() };

  try {
    const apiData = await mbRun(SQL);
    const rows    = apiData?.data?.rows ?? [];

    if (rows.length === 0) throw new Error('Query returned 0 rows — possible auth or SQL error');

    const mapped = mapRows(apiData);
    const nKeys  = Object.keys(mapped).length;

    if (nKeys === 0) throw new Error('mapRows produced 0 keys — check column names in response');

    Object.assign(counts, mapped);
    console.log(`\n✓ Mapped ${nKeys} metrics from ${rows.length} segment rows.`);

  } catch (err) {
    console.error(`\n✗ Query FAILED: ${err.message}`);
    // Fall back to all existing values so nothing goes blank
    counts = { ...existing, updated_at: existing.updated_at ?? counts.updated_at };
    console.warn('Using preserved existing counts.json values.');
  }

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(counts, null, 2));
  console.log(`Written → ${OUT_FILE}`);
})();
