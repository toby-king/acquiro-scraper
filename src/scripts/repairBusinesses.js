/**
 * Inserts any businesses from the CSV that are missing from Supabase.
 * Safe to run multiple times — checks listing_id before inserting.
 *
 * Run after applying 005_fix_business_numeric_columns.sql:
 *   node --env-file=.env src/scripts/repairBusinesses.js
 *
 * Required env vars: SUPABASE_URL, SUPABASE_SECRET_KEY, CSV_DIR
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parse } from 'csv-parse/sync';

const CSV_DIR = process.env.CSV_DIR;
if (!CSV_DIR) throw new Error('CSV_DIR required');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

const parseBool = v => v === 'yes' || v === 'true';
const parseNum  = v => (v === '' || v == null) ? null : Number(v);
function parseDate(v) {
  if (!v || !v.trim()) return null;
  const normalized = v.trim().replace(/\b(am|pm)\b/gi, m => m.toUpperCase());
  const d = new Date(normalized);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function readCsv(keyword) {
  const files = readdirSync(CSV_DIR);
  const match = files.find(f => f.toLowerCase().includes(keyword.toLowerCase()));
  if (!match) throw new Error(`No CSV found containing "${keyword}"`);
  return parse(readFileSync(join(CSV_DIR, match), 'utf8'), { columns: true, skip_empty_lines: true, bom: true });
}

async function main() {
  console.log('=== Business Repair ===\n');

  // Fetch all listing_ids already in Supabase
  const { data: existing, error: fetchErr } = await supabase
    .from('business')
    .select('listing_id');
  if (fetchErr) throw fetchErr;

  const existingIds = new Set(existing.map(r => r.listing_id).filter(Boolean));
  console.log(`${existingIds.size} businesses already in Supabase`);

  const records = readCsv('businesses');
  const missing = records.filter(r => r.listing_id && !existingIds.has(r.listing_id));
  console.log(`${missing.length} businesses missing — inserting now\n`);

  let inserted = 0;
  let failed = 0;

  for (const r of missing) {
    const { error } = await supabase.from('business').insert({
      business_name:    r.business_name    || null,
      description:      r.description      || null,
      sector:           r.sector           || null,
      sub_sector:       r.sub_sector       || null,
      url:              r.url              || null,
      location:         r.location         || null,
      region:           r.region           || null,
      image:            r.image            || null,
      asking_price:     parseNum(r.asking_price),
      turnover:         parseNum(r.turnover),
      net_profit:       parseNum(r.net_profit),
      rent:             parseNum(r.rent),
      leasehold:        parseNum(r.leasehold),
      ebit:             parseNum(r.ebit),
      ebitda:           parseNum(r.ebitda),
      freehold:         parseNum(r.freehold),
      franchise_fee:    parseNum(r.franchise_fee),
      investment:       parseNum(r.investment),
      more_info:        r.more_info        || null,
      other_financials: r.other_financials || null,
      source:           r.source           || null,
      listing_id:       r.listing_id       || null,
      archived:         parseBool(r.archived),
      last_seen_at:     parseDate(r.last_seen_at),
      last_verified_at: parseDate(r.last_verified_at),
      created_at:       parseDate(r['Creation Date']),
    });

    if (error) {
      console.error(`  ✗ "${r.business_name}": ${error.message}`);
      failed++;
    } else {
      console.log(`  ✓ "${r.business_name}"`);
      inserted++;
    }
  }

  console.log(`\n=== Done: ${inserted} inserted, ${failed} failed ===`);
}

main().catch(err => {
  console.error('\n!!! Failed:', err);
  process.exit(1);
});
