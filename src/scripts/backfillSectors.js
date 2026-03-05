/**
 * One-time backfill script: classify all existing Bubble Business listings into
 * canonical sectors and update their Pinecone metadata with `normalised_sectors`.
 *
 * Run:
 *   node src/scripts/backfillSectors.js
 *
 * Safe to re-run — listings that already have normalised_sectors in Pinecone are
 * skipped unless you pass --force.
 *
 * Flags:
 *   --force     Re-classify and overwrite existing normalised_sectors
 *   --dry-run   Classify and log but don't write to Pinecone
 */

import { Pinecone } from '@pinecone-database/pinecone';
import { classifySectors } from '../utils/sectorClassifier.js';

const BUBBLE_BASE  = 'https://toby-85612.bubbleapps.io/version-test/api/1.1';
const BUBBLE_LIMIT = 100;   // records per Bubble page
const PINECONE_FETCH_BATCH = 100; // max IDs per Pinecone fetch call
const CLASSIFY_CONCURRENCY = 5;  // parallel GPT calls per batch

const FORCE    = process.argv.includes('--force');
const DRY_RUN  = process.argv.includes('--dry-run');

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchBubblePage(cursor) {
  const apiKey = process.env.BUBBLE_API_KEY;
  if (!apiKey) throw new Error('BUBBLE_API_KEY env var is not set');

  const url = `${BUBBLE_BASE}/obj/Business?limit=${BUBBLE_LIMIT}&cursor=${cursor}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`Bubble returned HTTP ${res.status}`);
  const json = await res.json();
  return json.response; // { results, remaining, count }
}

/**
 * Fetch all Bubble Business records, paginated.
 * Returns an array of { _id, business_name, sector, description } objects.
 */
async function fetchAllBubbleBusinesses() {
  const all = [];
  let cursor = 0;

  while (true) {
    const page = await fetchBubblePage(cursor);
    const results = page.results ?? [];
    all.push(...results);
    process.stdout.write(`\r  Fetched ${all.length} / ${page.count} records from Bubble…`);
    if (!page.remaining || page.remaining === 0) break;
    cursor += results.length;
  }
  console.log(); // newline after progress indicator
  return all;
}

/**
 * Fetch a batch of Pinecone records by ID.
 * Returns a map of id → metadata.
 */
async function fetchPineconeBatch(index, ids) {
  const res = await index.fetch({ ids });
  const map = {};
  for (const [id, record] of Object.entries(res.records ?? {})) {
    map[id] = record.metadata ?? {};
  }
  return map;
}

/**
 * Run fn on items in batches, with limited concurrency within each batch.
 */
async function processBatches(items, batchSize, concurrency, fn) {
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    // Process concurrency items at a time within the batch
    for (let j = 0; j < batch.length; j += concurrency) {
      await Promise.all(batch.slice(j, j + concurrency).map(fn));
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const pineconeApiKey   = process.env.PINECONE_API_KEY;
  const pineconeIndex    = process.env.PINECONE_INDEX_NAME;
  if (!pineconeApiKey)  throw new Error('PINECONE_API_KEY env var is not set');
  if (!pineconeIndex)   throw new Error('PINECONE_INDEX_NAME env var is not set');
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY env var is not set');

  console.log(`[backfill] Starting sector backfill${DRY_RUN ? ' (DRY RUN)' : ''}${FORCE ? ' (FORCE)' : ''}`);

  const pc    = new Pinecone({ apiKey: pineconeApiKey });
  const index = pc.index(pineconeIndex);

  // 1. Fetch all Bubble Business records
  console.log('[backfill] Fetching Business records from Bubble…');
  const businesses = await fetchAllBubbleBusinesses();
  console.log(`[backfill] ${businesses.length} records found in Bubble`);

  if (businesses.length === 0) {
    console.log('[backfill] Nothing to do.');
    return;
  }

  // Debug: show first record's keys so we can confirm the ID field name
  // 2. Fetch existing Pinecone metadata in batches to detect already-classified records
  console.log('[backfill] Fetching existing Pinecone metadata…');
  const ids = businesses.map((b) => b._id).filter(Boolean);
  const pineconeMetaMap = {};
  for (let i = 0; i < ids.length; i += PINECONE_FETCH_BATCH) {
    const batchIds = ids.slice(i, i + PINECONE_FETCH_BATCH);
    const batchMap = await fetchPineconeBatch(index, batchIds);
    Object.assign(pineconeMetaMap, batchMap);
    process.stdout.write(`\r  Fetched Pinecone metadata for ${Math.min(i + PINECONE_FETCH_BATCH, ids.length)} / ${ids.length} records…`);
  }
  console.log();

  // 3. Determine which records need classifying
  const toClassify = businesses.filter((b) => {
    if (!b._id) return false;
    const meta = pineconeMetaMap[b._id];
    if (!meta) return false; // not in Pinecone (ghost listing) — skip
    if (!FORCE && meta.normalised_sectors?.length > 0) return false; // already done
    return true;
  });

  const skipped = businesses.length - toClassify.length;
  console.log(`[backfill] ${toClassify.length} to classify, ${skipped} skipped (ghost listings or already done)`);

  if (toClassify.length === 0) {
    console.log('[backfill] All records already classified. Use --force to re-classify.');
    return;
  }

  // 4. Classify + upsert
  let done = 0;
  let failed = 0;

  await processBatches(toClassify, PINECONE_FETCH_BATCH, CLASSIFY_CONCURRENCY, async (business) => {
    const { _id } = business;
    const business_name = business.business_name_text ?? business.business_name ?? '(unknown)';
    const sector        = business.sector1_text       ?? business.sector        ?? null;
    const description   = business.description_text   ?? business.description   ?? null;

    const normalisedSectors = await classifySectors(business_name, sector, description);

    done++;
    process.stdout.write(
      `\r  Classified ${done} / ${toClassify.length}  [${_id}] → [${normalisedSectors.join(', ') || 'none'}]   `,
    );

    if (DRY_RUN) return;

    if (normalisedSectors.length === 0) {
      // No sectors matched — don't overwrite existing metadata, just skip
      failed++;
      return;
    }

    // Fetch the existing record to get its current metadata (merge, don't overwrite)
    const existing = pineconeMetaMap[_id] ?? {};
    const updatedMeta = { ...existing, normalised_sectors: normalisedSectors };

    // Upsert requires the vector — fetch it from Pinecone
    const fetchRes = await index.fetch({ ids: [_id] });
    const record = fetchRes.records?.[_id];
    if (!record?.values?.length) {
      console.warn(`\n[backfill] No vector found in Pinecone for ${_id} — skipping`);
      failed++;
      return;
    }

    await index.upsert({ records: [{ id: _id, values: record.values, metadata: updatedMeta }] });
  });

  console.log(); // newline after progress
  console.log(`[backfill] Done. ${done - failed} updated, ${failed} skipped (no sectors matched or no Pinecone vector).`);
}

main().catch((err) => {
  console.error('[backfill] Fatal error:', err.message);
  process.exit(1);
});
