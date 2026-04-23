/**
 * One-time migration: Bubble.io → Supabase
 *
 * Users:          fetched from Bubble API (no CSV export available)
 * Everything else: read from CSV exports in CSV_DIR
 *
 * Run: node --env-file=.env src/scripts/migrateBubbleToSupabase.js
 *
 * Required env vars:
 *   BUBBLE_API_KEY            — for user migration only
 *   SUPABASE_URL, SUPABASE_SECRET_KEY
 *   OPENAI_API_KEY, PINECONE_API_KEY, PINECONE_INDEX_NAME
 *   CSV_DIR                   — path to Bubble CSV export folder
 *                               e.g. C:\Users\toby\Documents\acquiro_data
 */

import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { Pinecone } from '@pinecone-database/pinecone';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parse } from 'csv-parse/sync';

// ── Clients ──────────────────────────────────────────────────────────────────

const BUBBLE_BASE = 'https://toby-85612.bubbleapps.io/version-test/api/1.1';
const BUBBLE_KEY = process.env.BUBBLE_API_KEY;
if (!BUBBLE_KEY) throw new Error('BUBBLE_API_KEY required');

const CSV_DIR = process.env.CSV_DIR;
if (!CSV_DIR) throw new Error('CSV_DIR required — set to path of Bubble CSV export folder');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
const pineconeIndex = pinecone.index(process.env.PINECONE_INDEX_NAME);

// Bubble _id → Supabase UUID lookup (built up as each table migrates)
const idMap = {
  users: {},
  leads: {},
  business: {},
  agents: {},
  buyer_info: {},
  langcliffe_outreach: {},
  feature_announcement: {},
};

// ── CSV helpers ───────────────────────────────────────────────────────────────

function readCsv(keyword) {
  const files = readdirSync(CSV_DIR);
  const match = files.find(f => f.toLowerCase().includes(keyword.toLowerCase()));
  if (!match) throw new Error(`No CSV found in ${CSV_DIR} containing "${keyword}"`);
  console.log(`  [csv] Reading ${match}`);
  const content = readFileSync(join(CSV_DIR, match), 'utf8');
  return parse(content, { columns: true, skip_empty_lines: true, bom: true });
}

// Bubble CSVs export booleans as "yes"/"no"
const parseBool = v => v === 'yes' || v === 'true';

// Numeric fields come through as strings; empty string → null
const parseNum = v => (v === '' || v == null) ? null : Number(v);

// Bubble date format: "Feb 22, 2026 5:20 pm"
function parseDate(v) {
  if (!v || !v.trim()) return null;
  const normalized = v.trim().replace(/\b(am|pm)\b/gi, m => m.toUpperCase());
  const d = new Date(normalized);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function mapId(table, bubbleId) {
  if (!bubbleId || !bubbleId.trim()) return null;
  return idMap[table]?.[bubbleId.trim()] ?? null;
}

// ── Bubble API helpers (users only) ──────────────────────────────────────────

async function bubbleFetchAll(type) {
  const headers = { Authorization: `Bearer ${BUBBLE_KEY}` };
  const all = [];
  let cursor = 0;
  while (true) {
    const res = await fetch(`${BUBBLE_BASE}/obj/${type}?limit=100&cursor=${cursor}`, { headers });
    if (!res.ok) throw new Error(`Bubble GET /obj/${type} failed: ${res.status}`);
    const json = await res.json();
    const { results = [], remaining = 0 } = json.response ?? {};
    all.push(...results);
    console.log(`  [bubble] ${type}: fetched ${all.length} (${remaining} remaining)`);
    if (remaining <= 0) break;
    cursor += results.length;
  }
  return all;
}

// ── Table migrations ──────────────────────────────────────────────────────────

async function migrateUsers() {
  console.log('\n── Migrating users (Bubble API) ──');
  const records = await bubbleFetchAll('user');

  for (const u of records) {
    const email = u.authentication?.email?.email ?? null;
    if (!email) continue;

    // Must create via auth.admin so auth.users and public.users stay in sync
    const { data: authData, error: authErr } = await supabase.auth.admin.createUser({
      email,
      email_confirm: true,
    });

    if (authErr) {
      if (authErr.message?.includes('already')) {
        const { data: existing } = await supabase.from('users').select('id').eq('email', email).single();
        if (existing) {
          idMap.users[u._id] = existing.id;
          console.warn(`  User ${email} already exists — reusing ${existing.id}`);
          continue;
        }
      }
      console.warn(`  Skipping user ${email}: ${authErr.message}`);
      continue;
    }

    const userId = authData.user.id;

    await supabase.from('users').update({
      name: u.name_text ?? null,
      role: u.role_text ?? 'buyer',
      is_subscribed: u.is_subscribed_boolean ?? false,
      is_admin: u.is_admin_boolean ?? false,
      subscription_id: u.subscription_id_text ?? null,
      cancel_at: u.cancel_at_text ?? null,
      dealsuite_connected: u.dealsuite_connected_boolean ?? false,
      langcliffe_connected: u.langcliffe_connected_boolean ?? false,
    }).eq('id', userId);

    idMap.users[u._id] = userId;
  }

  console.log(`  ✓ ${Object.keys(idMap.users).length} users migrated`);
}

async function migrateLeads() {
  console.log('\n── Migrating leads ──');
  const records = readCsv('leads');

  for (const r of records) {
    const { data, error } = await supabase.from('leads').insert({
      name:           r.name           || null,
      email:          r.email          || null,
      converted:      parseBool(r.converted),
      completed_form: parseBool(r.completed_form),
      nudged:         parseBool(r.nudged),
      stage:          parseNum(r.stage),
      created_at:     parseDate(r['Creation Date']),
    }).select('id').single();

    if (error) { console.warn(`  Skipping lead ${r['unique id']}: ${error.message}`); continue; }
    idMap.leads[r['unique id']] = data.id;
  }

  console.log(`  ✓ ${Object.keys(idMap.leads).length} leads migrated`);
}

async function migrateBusinesses() {
  console.log('\n── Migrating businesses ──');
  const records = readCsv('businesses');

  let inserted = 0;
  for (const r of records) {
    const { data, error } = await supabase.from('business').insert({
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
    }).select('id').single();

    if (error) { console.warn(`  Skipping business "${r.business_name}": ${error.message}`); continue; }
    idMap.business[r['unique id']] = data.id;
    inserted++;
    if (inserted % 500 === 0) console.log(`  Progress: ${inserted}/${records.length}`);
  }

  console.log(`  ✓ ${inserted} businesses migrated`);
}

async function migrateAgents() {
  console.log('\n── Migrating agents ──');
  const records = readCsv('agents');

  for (const r of records) {
    const { data, error } = await supabase.from('agents').insert({
      lead_id:         mapId('leads', r.lead),
      user_id:         mapId('users', r.user),
      name:            r.name            || null,
      email:           r.email           || null,
      challenge_style: r.challenge_style || null,
      profanity:       parseBool(r.profanity),
      traits:          r.traits          || null,
      type:            r.type            || null,
      voice:           r.voice           || null,
      personality:     r.personality_options || null,
      created_at:      parseDate(r['Creation Date']),
    }).select('id').single();

    if (error) { console.warn(`  Skipping agent ${r['unique id']}: ${error.message}`); continue; }
    idMap.agents[r['unique id']] = data.id;
  }

  console.log(`  ✓ ${Object.keys(idMap.agents).length} agents migrated`);
}

async function migrateBuyerInfo() {
  console.log('\n── Migrating buyer_info ──');
  const records = readCsv('buyer-infos');

  const splitList = v => v ? v.split(',').map(s => s.trim()).filter(Boolean) : null;

  for (const r of records) {
    const { data, error } = await supabase.from('buyer_info').insert({
      lead_id:                  mapId('leads', r.lead),
      user_id:                  mapId('users', r.user),
      buyer_type:               r.buyer_type               || null,
      buying_reason:            r.buying_reason            || null,
      buying_experience:        r.buying_experience        || null,
      decision_speed:           r.decision_speed           || null,
      geography:                r.geography                || null,
      turnover_range:           r.turnover_range           || null,
      ebitda_range:             r.ebitda_range             || null,
      ebitda_margin_min:        r.ebitda_margin_min        || null,
      asset_base:               r.asset_base               || null,
      valuation_range:          r.valuation_range          || null,
      deal_structure_preference: r.deal_structure_preferences || null,
      funding_source:           r.funding_source           || null,
      business_age:             r.business_age             || null,
      employee_headcount:       r.employee_headcount       || null,
      customer_base_type:       r.customer_base_type       || null,
      contractual_recurrence:   r.contractual_recurrence   || null,
      ip_technology:            r.ip_technology            || null,
      physical_digital:         r.physical_digital         || null,
      involvement:              r.involvement              || null,
      problems:                 r.problems                 || null,
      industry_preferences:     splitList(r.industry_preferences),
      excluded_sectors:         splitList(r.excluded_sectors),
      company_overview:         r.company_overview         || null,
      langcliffe_contact_email: r.langcliffe_contact_email || null,
      initial_budget:           r.initial_budget           || null,
      misc_info:                r.misc_info                || null,
      is_returning:             parseBool(r.returning),
      created_at:               parseDate(r['Creation Date']),
    }).select('id').single();

    if (error) { console.warn(`  Skipping buyer_info ${r['unique id']}: ${error.message}`); continue; }
    idMap.buyer_info[r['unique id']] = data.id;
  }

  console.log(`  ✓ ${Object.keys(idMap.buyer_info).length} buyer_info records migrated`);
}

async function migrateMatches() {
  console.log('\n── Migrating matches ──');
  const records = readCsv('matches');

  const rows = [];
  let skipped = 0;
  for (const r of records) {
    const userId     = mapId('users', r.user);
    const businessId = mapId('business', r.business);
    if (!userId || !businessId) { skipped++; continue; }

    rows.push({
      user_id:       userId,
      business_id:   businessId,
      score:         parseNum(r.score),
      dismissed:     parseBool(r.dismissed),
      dismiss_reason: r.dismiss_reason || null,
      // match_reason not in CSV export — will be null for migrated records
      created_at:    parseDate(r['Creation Date']),
    });
  }

  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase.from('matches').insert(rows.slice(i, i + 500));
    if (error) throw new Error(`migrateMatches failed at chunk ${i}: ${error.message}`);
  }

  console.log(`  ✓ ${rows.length} matches migrated (${skipped} skipped — no user/business mapping)`);
}

async function migrateLangcliffeOutreach() {
  console.log('\n── Migrating langcliffe_outreach ──');
  const records = readCsv('langcliffe');

  for (const r of records) {
    const userId = mapId('users', r.user);
    if (!userId) { console.warn(`  Skipping outreach — no user mapping for "${r.user}"`); continue; }

    const { data, error } = await supabase.from('langcliffe_outreach').insert({
      user_id:               userId,
      listing_id:            r.listing_id            || null,
      langcliffe_contact:    r.langcliffe_contact    || null,
      business_name:         r.business_name         || null,
      draft_body:            r.draft_body            || null,
      inbound_email:         r.inbound_email         || null,
      status:                r.status                || null,
      sent_at:               parseDate(r.sent_at),
      langcliffe_reply_body: r.langcliffe_reply_body || null,
      reply_draft:           r.reply_draft           || null,
      conversation_history:  r.conversation_history  || null,
      nda_file:              r.nda_file              || null,
      signed_nda_file:       r.signed_nda_file       || null,
      acknowledgment_draft:  r.acknowledgment_draft  || null,
      nda_return_draft:      r.nda_return_draft      || null,
      thread_message_id:     r.thread_message_id     || null,
      im_url:                r.im_url                || null,
      im_password:           r.im_password           || null,
      created_at:            parseDate(r['Creation Date']),
    }).select('id').single();

    if (error) { console.warn(`  Skipping outreach ${r['unique id']}: ${error.message}`); continue; }
    idMap.langcliffe_outreach[r['unique id']] = data.id;
  }

  console.log(`  ✓ ${Object.keys(idMap.langcliffe_outreach).length} outreach records migrated`);
}

async function migrateEmails() {
  console.log('\n── Migrating emails ──');
  const records = readCsv('emails');

  const rows = [];
  let skipped = 0;
  for (const r of records) {
    const userId = mapId('users', r.user);
    if (!userId) { skipped++; continue; }
    rows.push({
      body:       r.body      || null,
      is_agent:   parseBool(r.is_agent),
      thread_id:  r.thread_id || null,
      user_id:    userId,
      created_at: parseDate(r['Creation Date']),
    });
  }

  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase.from('emails').insert(rows.slice(i, i + 500));
    if (error) throw new Error(`migrateEmails failed at chunk ${i}: ${error.message}`);
    console.log(`  Progress: ${Math.min(i + 500, rows.length)}/${rows.length}`);
  }

  console.log(`  ✓ ${rows.length} emails migrated (${skipped} skipped)`);
}

async function migrateNotifications() {
  console.log('\n── Migrating user_notification ──');
  const records = readCsv('usernotifications');

  const rows = [];
  let skipped = 0;
  for (const r of records) {
    const userId = mapId('users', r.user);
    if (!userId) { skipped++; continue; }
    rows.push({
      user_id:             userId,
      type:                r.type   || null,
      title:               r.title  || null,
      body:                r.body   || null,
      status:              r.status || 'unread',
      langcliffe_outreach: mapId('langcliffe_outreach', r.langcliffe_outreach) ?? (r.langcliffe_outreach || null),
      created_at:          parseDate(r['Creation Date']),
    });
  }

  if (rows.length > 0) {
    const { error } = await supabase.from('user_notification').insert(rows);
    if (error) throw new Error(`migrateNotifications failed: ${error.message}`);
  }

  console.log(`  ✓ ${rows.length} notifications migrated (${skipped} skipped)`);
}

async function migratePursueRequests() {
  console.log('\n── Migrating pursue_request ──');
  const records = readCsv('pursue');

  const rows = [];
  let skipped = 0;
  for (const r of records) {
    const userId = mapId('users', r.user);
    if (!userId) { skipped++; continue; }
    rows.push({
      user_id:         userId,
      business_id:     mapId('business', r.business),
      business_name:   r.business_name   || null,
      status:          r.status          || 'pending',
      listing_url:     r.listing_url     || null,
      admin_notes:     r.admin_notes     || null,
      notified_status: r.notified_status || null,
      created_at:      parseDate(r['Creation Date']),
    });
  }

  if (rows.length > 0) {
    const { error } = await supabase.from('pursue_request').insert(rows);
    if (error) throw new Error(`migratePursueRequests failed: ${error.message}`);
  }

  console.log(`  ✓ ${rows.length} pursue requests migrated (${skipped} skipped)`);
}

async function migrateFeatureAnnouncements() {
  console.log('\n── Migrating feature_announcement ──');
  const records = readCsv('featureannouncements');

  for (const r of records) {
    const { data, error } = await supabase.from('feature_announcement').insert({
      name:             r.name             || null,
      headline:         r.headline         || null,
      cta:              r.cta              || null,
      active:           parseBool(r.active),
      max_impressions:  parseNum(r.max_impressions),
      completion_field: r.completion_field || null,
      created_at:       parseDate(r['Creation Date']),
    }).select('id').single();

    if (error) { console.warn(`  Skipping feature ${r['unique id']}: ${error.message}`); continue; }
    idMap.feature_announcement[r['unique id']] = data.id;
  }

  console.log(`  ✓ ${Object.keys(idMap.feature_announcement).length} feature announcements migrated`);
}

async function migrateUserFeatureImpressions() {
  console.log('\n── Migrating user_feature_impression ──');
  const records = readCsv('userfeatureimpressions');

  const rows = [];
  let skipped = 0;
  for (const r of records) {
    const userId    = mapId('users', r.user);
    const featureId = mapId('feature_announcement', r.feature);
    if (!userId || !featureId) { skipped++; continue; }
    rows.push({
      user_id:    userId,
      feature_id: featureId,
      impressions: parseNum(r.impressions) ?? 0,
      created_at: parseDate(r['Creation Date']),
    });
  }

  if (rows.length > 0) {
    const { error } = await supabase.from('user_feature_impression').insert(rows);
    if (error) throw new Error(`migrateUserFeatureImpressions failed: ${error.message}`);
  }

  console.log(`  ✓ ${rows.length} feature impressions migrated (${skipped} skipped)`);
}

async function migrateScrapeLog() {
  console.log('\n── Migrating scrape_log ──');
  const records = readCsv('scrape-logs');

  const rows = records.map(r => ({
    last_run:         parseDate(r.last_run),
    records_added:    parseNum(r.records_added),
    records_archived: parseNum(r.records_archived),
    matches_made:     parseNum(r.matches_made),
    created_at:       parseDate(r['Creation Date']),
  }));

  if (rows.length > 0) {
    const { error } = await supabase.from('scrape_log').insert(rows);
    if (error) throw new Error(`migrateScrapeLog failed: ${error.message}`);
  }

  console.log(`  ✓ ${rows.length} scrape logs migrated`);
}

async function migrateSources() {
  console.log('\n── Migrating sources ──');
  const records = readCsv('sources');

  const rows = records.map(r => ({
    name:       r.name || null,
    url:        r.url  || null,
    created_at: parseDate(r['Creation Date']),
  }));

  if (rows.length > 0) {
    const { error } = await supabase.from('sources').insert(rows);
    if (error) throw new Error(`migrateSources failed: ${error.message}`);
  }

  console.log(`  ✓ ${rows.length} sources migrated`);
}

// ── Pinecone re-index ─────────────────────────────────────────────────────────

async function reindexPinecone() {
  console.log('\n── Re-indexing Pinecone ──');

  console.log('  Deleting all existing vectors...');
  await pineconeIndex.deleteAll();
  console.log('  ✓ Old vectors deleted');

  const { data: businesses, error } = await supabase
    .from('business')
    .select('*')
    .eq('archived', false);
  if (error) throw new Error(`Failed to fetch businesses: ${error.message}`);
  console.log(`  ${businesses.length} non-archived businesses to embed`);

  let embedded = 0;
  let failed = 0;

  for (let i = 0; i < businesses.length; i += 100) {
    const batch = businesses.slice(i, i + 100);

    const goldenStrings = batch.map(b => {
      const parts = [];
      if (b.business_name) parts.push(b.business_name + '.');
      if (b.sector)        parts.push(`Sector: ${b.sector}.`);
      if (b.sub_sector)    parts.push(`Sub-sector: ${b.sub_sector}.`);
      if (b.location)      parts.push(`Location: ${b.location}.`);
      if (b.description)   parts.push(b.description.trim());
      return parts.join(' ') || '(no description)';
    });

    let embeddings;
    try {
      const res = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: goldenStrings,
      });
      embeddings = res.data;
    } catch (err) {
      console.warn(`  Batch ${i}–${i + batch.length} embedding failed — skipping: ${err.message}`);
      failed += batch.length;
      continue;
    }

    const vectors = [];
    for (let j = 0; j < batch.length; j++) {
      const b = batch[j];
      const embedding = embeddings[j]?.embedding;
      if (!embedding) { failed++; continue; }

      const metadata = {};
      for (const field of ['asking_price', 'leasehold', 'freehold', 'turnover', 'net_profit', 'ebit', 'ebitda', 'rent', 'investment', 'franchise_fee']) {
        if (b[field] != null && isFinite(b[field])) metadata[field] = b[field];
      }
      for (const field of ['business_name', 'location', 'region', 'sector', 'sub_sector', 'source', 'url']) {
        if (b[field]) metadata[field] = b[field];
      }

      vectors.push({ id: b.id, values: embedding, metadata });
      embedded++;
    }

    if (vectors.length > 0) {
      await pineconeIndex.upsert({ records: vectors });
    }

    console.log(`  Progress: ${i + batch.length}/${businesses.length} (${embedded} embedded, ${failed} failed)`);
  }

  console.log(`  ✓ Pinecone re-indexed: ${embedded} vectors, ${failed} failures`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Bubble → Supabase Migration ===\n');
  console.log(`CSV_DIR: ${CSV_DIR}`);

  await migrateUsers();
  await migrateLeads();
  await migrateBusinesses();
  await migrateAgents();
  await migrateBuyerInfo();
  await migrateMatches();
  await migrateLangcliffeOutreach();
  await migrateEmails();
  await migrateNotifications();
  await migratePursueRequests();
  await migrateFeatureAnnouncements();
  await migrateUserFeatureImpressions();
  await migrateScrapeLog();
  await migrateSources();

  console.log('\n=== Migration Summary ===');
  for (const [table, map] of Object.entries(idMap)) {
    console.log(`  ${table}: ${Object.keys(map).length} records mapped`);
  }

  await reindexPinecone();

  console.log('\n=== Migration Complete ===');
}

main().catch(err => {
  console.error('\n!!! Migration failed:', err);
  process.exit(1);
});
