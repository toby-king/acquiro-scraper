/**
 * One-time migration: Bubble.io → Supabase
 *
 * Reads all records from Bubble, inserts into Supabase with new UUIDs,
 * then re-indexes all non-archived businesses into Pinecone.
 *
 * Run: node --env-file=.env src/scripts/migrateBubbleToSupabase.js
 *
 * Required env vars:
 *   BUBBLE_API_KEY, SUPABASE_URL, SUPABASE_SECRET_KEY,
 *   OPENAI_API_KEY, PINECONE_API_KEY, PINECONE_INDEX_NAME
 */

import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { Pinecone } from '@pinecone-database/pinecone';

// ── Clients ──────────────────────────────────────────────────────────────────

const BUBBLE_BASE = 'https://toby-85612.bubbleapps.io/version-test/api/1.1';
const BUBBLE_KEY = process.env.BUBBLE_API_KEY;
if (!BUBBLE_KEY) throw new Error('BUBBLE_API_KEY required');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
const pineconeIndex = pinecone.index(process.env.PINECONE_INDEX_NAME);

// Bubble _id → Supabase UUID lookup
const idMap = {
  users: {},
  leads: {},
  business: {},
  agents: {},
  buyer_info: {},
  langcliffe_outreach: {},
  feature_announcement: {},
};

// ── Bubble helpers ───────────────────────────────────────────────────────────

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
    console.log(`  [bubble] ${type}: fetched ${all.length} records (${remaining} remaining)`);
    if (remaining <= 0) break;
    cursor += results.length;
  }

  return all;
}

// ── Migration helpers ────────────────────────────────────────────────────────

function mapId(table, bubbleId) {
  if (!bubbleId) return null;
  return idMap[table]?.[bubbleId] ?? null;
}

async function insertBatch(table, rows) {
  if (rows.length === 0) return;
  // Insert in chunks of 500 to avoid payload limits
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await supabase.from(table).insert(chunk);
    if (error) throw new Error(`Insert into ${table} failed at chunk ${i}: ${error.message}`);
  }
}

// ── Table migrations ─────────────────────────────────────────────────────────

async function migrateUsers() {
  console.log('\n── Migrating users ──');
  const records = await bubbleFetchAll('user');

  const rows = records.map(u => {
    const email = u.authentication?.email?.email ?? null;
    if (!email) return null; // skip users without email

    const row = {
      email,
      name: u.name_text ?? u.name ?? null,
      role: u.role_text ?? 'buyer',
      is_subscribed: u.is_subscribed_boolean ?? false,
      is_admin: u.is_admin_boolean ?? false,
      subscription_id: u.subscription_id_text ?? null,
      cancel_at: u.cancel_at_text ?? null,
      dealsuite_connected: u.dealsuite_connected_boolean ?? false,
      langcliffe_connected: u.langcliffe_connected_boolean ?? false,
      created_at: u['Created Date'] ?? new Date().toISOString(),
    };

    return { bubbleId: u._id, row };
  }).filter(Boolean);

  // Insert one at a time because we need the generated UUIDs back
  for (const { bubbleId, row } of rows) {
    const { data, error } = await supabase.from('users').insert(row).select('id').single();
    if (error) {
      console.warn(`  Skipping user ${row.email}: ${error.message}`);
      continue;
    }
    idMap.users[bubbleId] = data.id;
  }

  console.log(`  ✓ ${Object.keys(idMap.users).length} users migrated`);
}

async function migrateLeads() {
  console.log('\n── Migrating leads ──');
  const records = await bubbleFetchAll('Leads');

  const rows = [];
  for (const l of records) {
    const { data, error } = await supabase.from('leads').insert({
      name: l.name_text ?? null,
      email: l.email_text ?? null,
      converted: l.converted_boolean ?? false,
      completed_form: l.completed_form_boolean ?? false,
      nudged: l.nudged_boolean ?? false,
      stage: l.stage_number ?? null,
      created_at: l['Created Date'] ?? new Date().toISOString(),
    }).select('id').single();

    if (error) {
      console.warn(`  Skipping lead ${l._id}: ${error.message}`);
      continue;
    }
    idMap.leads[l._id] = data.id;
  }

  console.log(`  ✓ ${Object.keys(idMap.leads).length} leads migrated`);
}

async function migrateBusinesses() {
  console.log('\n── Migrating businesses ──');
  const records = await bubbleFetchAll('Business');

  for (const b of records) {
    const { data, error } = await supabase.from('business').insert({
      business_name: b.business_name_text ?? null,
      description: b.description_text ?? null,
      sector: b.sector1_text ?? null,
      sub_sector: b.sub_sector_text ?? null,
      url: b.url_text ?? null,
      location: b.location_text ?? null,
      region: b.region_text ?? null,
      image: b.image_image ?? null,
      asking_price: b.asking_price_number ?? null,
      turnover: b.turnover_number ?? null,
      net_profit: b.net_profit_number ?? null,
      rent: b.rent_number ?? null,
      leasehold: b.leasehold_number ?? null,
      ebit: b.ebit_number ?? null,
      ebitda: b.ebitda_number ?? null,
      freehold: b.freehold_number ?? null,
      franchise_fee: b.franchise_fee_number ?? null,
      investment: b.investment_number ?? null,
      more_info: b.more_info_text ?? null,
      other_financials: b.other_financials_text ?? null,
      source: b.source_text ?? null,
      listing_id: b.listing_id_text ?? null,
      archived: b.archived_boolean ?? false,
      last_seen_at: b.last_seen_at_date ?? null,
      last_verified_at: b.last_verified_at_date ?? null,
      created_at: b['Created Date'] ?? new Date().toISOString(),
    }).select('id').single();

    if (error) {
      console.warn(`  Skipping business ${b._id} (${b.business_name_text}): ${error.message}`);
      continue;
    }
    idMap.business[b._id] = data.id;
  }

  console.log(`  ✓ ${Object.keys(idMap.business).length} businesses migrated`);
}

async function migrateAgents() {
  console.log('\n── Migrating agents ──');
  const records = await bubbleFetchAll('Agents');

  for (const a of records) {
    const { data, error } = await supabase.from('agents').insert({
      lead_id: mapId('leads', a.lead_custom_leads) ?? null,
      user_id: mapId('users', a.user_user) ?? null,
      name: a.name_text ?? null,
      email: a.email_text ?? null,
      challenge_style: a.style_text ?? null,
      profanity: a.profanity_boolean ?? false,
      traits: a.traits_text ?? null,
      type: a.type_text ?? null,
      voice: a.voice_text ?? null,
      personality: a.personality_options_option_personalityoptions ?? null,
      created_at: a['Created Date'] ?? new Date().toISOString(),
    }).select('id').single();

    if (error) {
      console.warn(`  Skipping agent ${a._id}: ${error.message}`);
      continue;
    }
    idMap.agents[a._id] = data.id;
  }

  console.log(`  ✓ ${Object.keys(idMap.agents).length} agents migrated`);
}

async function migrateBuyerInfo() {
  console.log('\n── Migrating buyer_info ──');
  const records = await bubbleFetchAll('Buyer_Info');

  for (const b of records) {
    const { data, error } = await supabase.from('buyer_info').insert({
      lead_id: mapId('leads', b.lead_custom_leads) ?? null,
      user_id: mapId('users', b.user_user) ?? null,
      buyer_type: b.buyer_type_text ?? null,
      buying_reason: b.buying_reason_text ?? null,
      buying_experience: b.buying_experience_text ?? null,
      decision_speed: b.decision_speed_text ?? null,
      geography: b.geography_text ?? null,
      turnover_range: b.turnover_range_text ?? null,
      ebitda_range: b.ebitda_range_text ?? null,
      ebitda_margin_min: b.ebitda_margin_min_text ?? null,
      asset_base: b.asset_base_text ?? null,
      valuation_range: b.valuation_range_text ?? null,
      deal_structure_preference: b.deal_structure_preferences_text ?? null,
      funding_source: b.funding_source_text ?? null,
      business_age: b.business_age_text ?? null,
      employee_headcount: b.employee_headcount_text ?? null,
      customer_base_type: b.customer_base_type_text ?? null,
      contractual_recurrence: b.contractual_recurrence_text ?? null,
      ip_technology: b.ip_technology_text ?? null,
      physical_digital: b.physical_digital_text ?? null,
      involvement: b.involvement_text ?? null,
      problems: b.problems_text ?? null,
      industry_preferences: b.industry_preferences_list_option_sectors ?? null,
      excluded_sectors: b.excluded_sectors_list_option_sectors ?? null,
      company_overview: b.company_overview_text ?? null,
      langcliffe_contact_email: b.langcliffe_contact_email_text ?? null,
      initial_budget: b.initial_budget_text ?? null,
      misc_info: b.misc_info_text ?? null,
      is_returning: b.is_returning_boolean ?? false,
      created_at: b['Created Date'] ?? new Date().toISOString(),
    }).select('id').single();

    if (error) {
      console.warn(`  Skipping buyer_info ${b._id}: ${error.message}`);
      continue;
    }
    idMap.buyer_info[b._id] = data.id;
  }

  console.log(`  ✓ ${Object.keys(idMap.buyer_info).length} buyer_info records migrated`);
}

async function migrateMatches() {
  console.log('\n── Migrating matches ──');
  const records = await bubbleFetchAll('matches');

  const rows = [];
  let skipped = 0;
  for (const m of records) {
    const userId = mapId('users', m.user_user);
    const businessId = mapId('business', m.business_custom_business);
    if (!userId || !businessId) { skipped++; continue; }

    rows.push({
      user_id: userId,
      business_id: businessId,
      score: m.score_number ?? null,
      match_reason: m.match_reason_text ?? null,
      dismissed: m.dismissed_boolean ?? false,
      dismiss_reason: m.dismiss_reason_text ?? null,
      created_at: m['Created Date'] ?? new Date().toISOString(),
    });
  }

  await insertBatch('matches', rows);
  console.log(`  ✓ ${rows.length} matches migrated (${skipped} skipped — missing user/business)`);
}

async function migrateLangcliffeOutreach() {
  console.log('\n── Migrating langcliffe_outreach ──');
  const records = await bubbleFetchAll('LangcliffeOutreach');

  for (const o of records) {
    const userId = mapId('users', o.user_user);
    if (!userId) continue;

    const { data, error } = await supabase.from('langcliffe_outreach').insert({
      user_id: userId,
      listing_id: o.listing_id_text ?? null,
      langcliffe_contact: o.langcliffe_contact_text ?? null,
      business_name: o.business_name_text ?? null,
      draft_body: o.draft_body_text ?? null,
      inbound_email: o.inbound_email_text ?? null,
      status: o.status_text ?? null,
      sent_at: o.sent_at_date ?? null,
      langcliffe_reply_body: o.langcliffe_reply_body_text ?? null,
      reply_draft: o.reply_draft_text ?? null,
      conversation_history: o.conversation_history_text ?? null,
      nda_file: o.nda_file_text ?? null,
      signed_nda_file: o.signed_nda_file_text ?? null,
      acknowledgment_draft: o.acknowledgment_draft_text ?? null,
      nda_return_draft: o.nda_return_draft_text ?? null,
      thread_message_id: o.thread_message_id_text ?? null,
      im_url: o.im_url_text ?? null,
      im_password: o.im_password_text ?? null,
      created_at: o['Created Date'] ?? new Date().toISOString(),
    }).select('id').single();

    if (error) {
      console.warn(`  Skipping outreach ${o._id}: ${error.message}`);
      continue;
    }
    idMap.langcliffe_outreach[o._id] = data.id;
  }

  console.log(`  ✓ ${Object.keys(idMap.langcliffe_outreach).length} outreach records migrated`);
}

async function migrateEmails() {
  console.log('\n── Migrating emails ──');
  const records = await bubbleFetchAll('Emails');

  const rows = [];
  let skipped = 0;
  for (const e of records) {
    const userId = mapId('users', e.user_user);
    if (!userId) { skipped++; continue; }

    rows.push({
      body: e.body_text ?? null,
      is_agent: e.is_agent_boolean ?? false,
      thread_id: e.thread_id_text ?? null,
      user_id: userId,
      created_at: e['Created Date'] ?? new Date().toISOString(),
    });
  }

  await insertBatch('emails', rows);
  console.log(`  ✓ ${rows.length} emails migrated (${skipped} skipped)`);
}

async function migrateNotifications() {
  console.log('\n── Migrating user_notification ──');
  const records = await bubbleFetchAll('UserNotification');

  const rows = [];
  let skipped = 0;
  for (const n of records) {
    const userId = mapId('users', n.user_user);
    if (!userId) { skipped++; continue; }

    rows.push({
      user_id: userId,
      type: n.type_text ?? null,
      title: n.title_text ?? null,
      body: n.body_text ?? null,
      status: n.status_text ?? 'unread',
      langcliffe_outreach: mapId('langcliffe_outreach', n.langcliffe_outreach_text) ?? n.langcliffe_outreach_text ?? null,
      created_at: n['Created Date'] ?? new Date().toISOString(),
    });
  }

  await insertBatch('user_notification', rows);
  console.log(`  ✓ ${rows.length} notifications migrated (${skipped} skipped)`);
}

async function migratePursueRequests() {
  console.log('\n── Migrating pursue_request ──');
  const records = await bubbleFetchAll('Pursue_Request');

  const rows = [];
  let skipped = 0;
  for (const r of records) {
    const userId = mapId('users', r.user_user);
    const businessId = mapId('business', r.business_custom_business);
    if (!userId) { skipped++; continue; }

    rows.push({
      user_id: userId,
      business_id: businessId,
      business_name: r.business_name_text ?? null,
      status: r.status_text ?? 'pending',
      listing_url: r.listing_url_text ?? null,
      admin_notes: r.admin_notes_text ?? null,
      notified_status: r.notified_status_text ?? null,
      created_at: r['Created Date'] ?? new Date().toISOString(),
    });
  }

  await insertBatch('pursue_request', rows);
  console.log(`  ✓ ${rows.length} pursue requests migrated (${skipped} skipped)`);
}

async function migrateFeatureAnnouncements() {
  console.log('\n── Migrating feature_announcement ──');
  const records = await bubbleFetchAll('FeatureAnnouncement');

  for (const f of records) {
    const { data, error } = await supabase.from('feature_announcement').insert({
      name: f.name_text ?? null,
      headline: f.headline_text ?? null,
      cta: f.cta_text ?? null,
      active: f.active_boolean ?? false,
      max_impressions: f.max_impressions_number ?? null,
      completion_field: f.completion_field_text ?? null,
      created_at: f['Created Date'] ?? new Date().toISOString(),
    }).select('id').single();

    if (error) {
      console.warn(`  Skipping feature ${f._id}: ${error.message}`);
      continue;
    }
    idMap.feature_announcement[f._id] = data.id;
  }

  console.log(`  ✓ ${Object.keys(idMap.feature_announcement).length} feature announcements migrated`);
}

async function migrateUserFeatureImpressions() {
  console.log('\n── Migrating user_feature_impression ──');
  const records = await bubbleFetchAll('UserFeatureImpression');

  const rows = [];
  let skipped = 0;
  for (const i of records) {
    const userId = mapId('users', i.user_user);
    const featureId = mapId('feature_announcement', i.feature_custom_featureannouncement);
    if (!userId || !featureId) { skipped++; continue; }

    rows.push({
      user_id: userId,
      feature_id: featureId,
      impressions: i.impressions_number ?? 0,
      created_at: i['Created Date'] ?? new Date().toISOString(),
    });
  }

  await insertBatch('user_feature_impression', rows);
  console.log(`  ✓ ${rows.length} feature impressions migrated (${skipped} skipped)`);
}

async function migrateScrapeLog() {
  console.log('\n── Migrating scrape_log ──');
  const records = await bubbleFetchAll('Scrape_Log');

  const rows = records.map(s => ({
    last_run: s.last_run_date ?? s.last_run ?? null,
    records_added: s.records_added_number ?? s.records_added ?? null,
    records_archived: s.records_archived_number ?? s.records_archived ?? null,
    matches_made: s.matched_made_number ?? s.matches_made ?? null,
    created_at: s['Created Date'] ?? new Date().toISOString(),
  }));

  await insertBatch('scrape_log', rows);
  console.log(`  ✓ ${rows.length} scrape logs migrated`);
}

// ── Pinecone re-index ────────────────────────────────────────────────────────

async function reindexPinecone() {
  console.log('\n── Re-indexing Pinecone ──');

  // 1. Delete all existing vectors
  console.log('  Deleting all existing vectors...');
  await pineconeIndex.deleteAll();
  console.log('  ✓ Old vectors deleted');

  // 2. Fetch all non-archived businesses from Supabase
  const { data: businesses, error } = await supabase
    .from('business')
    .select('*')
    .eq('archived', false);

  if (error) throw new Error(`Failed to fetch businesses: ${error.message}`);
  console.log(`  ${businesses.length} non-archived businesses to embed`);

  // 3. Embed and upsert in batches of 100
  let embedded = 0;
  let failed = 0;

  for (let i = 0; i < businesses.length; i += 100) {
    const batch = businesses.slice(i, i + 100);

    const vectors = [];
    for (const b of batch) {
      const parts = [];
      if (b.business_name) parts.push(b.business_name + '.');
      if (b.sector) parts.push(`Sector: ${b.sector}.`);
      if (b.sub_sector) parts.push(`Sub-sector: ${b.sub_sector}.`);
      if (b.location) parts.push(`Location: ${b.location}.`);
      if (b.description) parts.push(b.description.trim());
      const goldenString = parts.join(' ') || '(no description)';

      try {
        const embeddingRes = await openai.embeddings.create({
          model: 'text-embedding-3-small',
          input: goldenString,
        });

        const metadata = {};
        for (const field of ['asking_price', 'leasehold', 'freehold', 'turnover', 'net_profit', 'ebit', 'ebitda', 'rent', 'investment', 'franchise_fee']) {
          if (b[field] != null && isFinite(b[field])) metadata[field] = b[field];
        }
        for (const field of ['business_name', 'location', 'region', 'sector', 'sub_sector', 'source', 'url']) {
          if (b[field]) metadata[field] = b[field];
        }

        vectors.push({
          id: b.id, // Supabase UUID
          values: embeddingRes.data[0].embedding,
          metadata,
        });
        embedded++;
      } catch (err) {
        console.warn(`  Failed to embed ${b.id} (${b.business_name}): ${err.message}`);
        failed++;
      }
    }

    if (vectors.length > 0) {
      await pineconeIndex.upsert({ records: vectors });
    }

    console.log(`  Progress: ${embedded + failed}/${businesses.length} (${embedded} embedded, ${failed} failed)`);
  }

  console.log(`  ✓ Pinecone re-indexed: ${embedded} vectors, ${failed} failures`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Bubble → Supabase Migration ===\n');

  // Phase 1: Migrate data (order matters — FK dependencies)
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

  // Phase 2: Summary
  console.log('\n=== Migration Summary ===');
  for (const [table, map] of Object.entries(idMap)) {
    console.log(`  ${table}: ${Object.keys(map).length} records`);
  }

  // Phase 3: Re-index Pinecone with new Supabase UUIDs
  await reindexPinecone();

  console.log('\n=== Migration Complete ===');
}

main().catch(err => {
  console.error('\n!!! Migration failed:', err);
  process.exit(1);
});
