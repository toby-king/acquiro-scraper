/**
 * Acquiro Scraper — HTTP API server.
 *
 * POST /scrape
 *   Body (JSON): { "sources": "rightbiz", "pages": 3 }
 *            or: { "sources": ["rightbiz", "cogogo"], "pages": 3 }
 *
 *   Response: {
 *     "pages": 3,
 *     "count": 75,
 *     "by_source": { "Rightbiz": 40, "CoGoGo": 35 },
 *     "listings": [...]
 *   }
 *
 * POST /api/generate-matches
 *   Body (JSON): { "user_id": "<bubble_user_id>" }
 *
 *   Response: { "matched": N, "business_ids": [...] }
 *
 * Valid source values: rightbiz, cogogo, daltons, businessesforsale (alias: bfs)
 *
 * Run:
 *   node src/server.js
 *   PORT=8080 node src/server.js
 */

import { createServer } from 'http';
import OpenAI from 'openai';
import { Pinecone } from '@pinecone-database/pinecone';
import { RightbizScraper } from './scrapers/rightbiz.js';
import { CoGoGoScraper } from './scrapers/cogogo.js';
import { DaltonsScraper } from './scrapers/daltons.js';
import { BusinessesForSaleScraper } from './scrapers/businessesforsale.js';
import { getBuyerInfo, getExistingMatches } from './utils/bubbleClient.js';

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const BUBBLE_BASE = 'https://toby-85612.bubbleapps.io/version-test/api/1.1';

const SCRAPERS = {
  rightbiz:          () => new RightbizScraper(),
  cogogo:            () => new CoGoGoScraper(),
  daltons:           () => new DaltonsScraper(),
  businessesforsale: () => new BusinessesForSaleScraper(),
  bfs:               () => new BusinessesForSaleScraper(),
};

const VALID_SOURCES = Object.keys(SCRAPERS).filter((k) => k !== 'bfs').join(', ');

// ── Generic helpers ───────────────────────────────────────────────────────────

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}

function normaliseKey(raw) {
  return String(raw).toLowerCase().replace(/[\s_-]/g, '');
}

// ── generate-matches helpers ──────────────────────────────────────────────────

/**
 * Retrieve a field from a Bubble profile object, trying multiple key variants.
 * Returns null for missing keys, empty strings, and empty arrays.
 */
function getField(profile, ...keys) {
  for (const key of keys) {
    const v = profile[key];
    if (v == null) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    return v;
  }
  return null;
}

/**
 * Parse a financial string like "£2M", "500k", "£1,200,000" into a number.
 * Returns null if no number can be found.
 */
function parseMoney(text) {
  if (text == null) return null;
  const clean = String(text).toLowerCase().replace(/[£$,\s]/g, '');
  const match = clean.match(/(\d+\.?\d*)\s*(bn|m|k)?/);
  if (!match) return null;
  const base = parseFloat(match[1]);
  const suffix = match[2];
  if (suffix === 'bn') return base * 1_000_000_000;
  if (suffix === 'm')  return base * 1_000_000;
  if (suffix === 'k')  return base * 1_000;
  return base;
}

/**
 * Parse a range string like "£100k-£200k", "over £2m", "up to £500k".
 * Returns { min, max } where missing bounds default to 0 / Infinity.
 */
function parseRange(text) {
  if (!text || String(text).trim() === '') return { min: 0, max: Infinity };
  const lower = text.toLowerCase();

  // Find all numeric tokens in order
  const tokens = [];
  const cleaned = lower.replace(/[£$,]/g, '');
  const rx = /(\d+\.?\d*)\s*(bn|m|k)?/g;
  let m;
  while ((m = rx.exec(cleaned)) !== null) {
    const base = parseFloat(m[1]);
    const s = m[2];
    tokens.push(s === 'bn' ? base * 1e9 : s === 'm' ? base * 1e6 : s === 'k' ? base * 1e3 : base);
  }

  if (tokens.length === 0) return { min: 0, max: Infinity };
  if (tokens.length >= 2)  return { min: tokens[0], max: tokens[1] };

  // Single token — determine direction from keywords
  const val = tokens[0];
  if (/over|above|more than|\+/.test(lower)) return { min: val, max: Infinity };
  if (/up to|under|below/.test(lower))       return { min: 0,   max: val };
  return { min: val, max: Infinity };
}

/**
 * Parse a percentage string like "20%" → 0.2. Returns null if not found.
 */
function parsePercent(text) {
  if (!text) return null;
  const match = String(text).match(/(\d+\.?\d*)\s*%/);
  return match ? parseFloat(match[1]) / 100 : null;
}

/**
 * Calculate the maximum acquisition price the buyer can target, applying a
 * leverage multiplier based on their funding source.
 * Returns Infinity if no budget is parseable (omit the filter).
 */
function calcMaxPrice(profile) {
  const budget = parseMoney(getField(profile, 'initial_budget', 'initial_budget_text'));
  if (budget == null) return Infinity;

  const src = (getField(profile, 'funding_source', 'funding_source_text') ?? '').toLowerCase();
  let multiplier = 1;
  if (/debt|financ/.test(src))  multiplier = 3;
  else if (/seller/.test(src))  multiplier = 2;

  return budget * multiplier;
}

/**
 * Concatenate all soft preference fields into a single descriptive string
 * for vectorisation. Null / blank fields are silently omitted.
 */
function buildGoldenString(p) {
  const get = (...keys) => getField(p, ...keys);
  const lines = [];

  const add = (label, ...keys) => {
    const v = get(...keys);
    if (v == null) return;
    const display = Array.isArray(v) ? v.join(', ') : v;
    lines.push(`${label}: ${display}`);
  };

  add('Buyer type',                    'buyer_type', 'buyer_type_text');
  add('Buying experience',             'buying_experience', 'buying_experience_text');
  add('Reason for buying',             'buying_reason', 'buying_reason_text');
  add('Preferred sectors',             'industry_preferences_list_option_sectors', 'industry_preferences', 'industry_preferences_text');
  add('Excluded sectors',              'excluded_sectors_list_option_sectors', 'excluded_sectors', 'excluded_sectors_text');
  add('Preferred employee headcount',  'employee_headcount', 'employee_headcount_text');
  add('Level of involvement preferred','involvement', 'involvement_text');
  add('Preferred business age',        'business_age', 'business_age_text');
  add('Asset base preference',         'asset_base', 'asset_base_text');
  add('Revenue recurrence preference', 'contractual_recurrence', 'contractual_recurrence_text');
  add('Customer base type',            'customer_base_type', 'customer_base_type_text');
  add('IP and technology preference',  'ip_technology', 'ip_technology_text');
  add('Physical vs digital',           'physical_digital', 'physical_digital_text');
  add('Preferred geography',           'geography', 'geography_text');
  add('Deal structure preferences',    'deal_structure_preferences', 'deal_structure_preferences_text');
  add('Decision speed',                'decision_speed', 'decision_speed_text');
  add('Additional notes',              'misc_info', 'misc_info_text');

  return lines.join('. ');
}

// ── Sector synonym expansion ──────────────────────────────────────────────────
// Keyed by the exact Bubble sector label (lowercased). Values are the terms we
// substring-match against a listing's sector field and business name.
const SECTOR_SYNONYMS = {
  'agriculture & natural resources': [
    'farm', 'farming', 'agricultural', 'horticulture', 'livestock', 'crop',
    'forestry', 'fishery', 'equestrian', 'rural', 'garden centre', 'plant nursery',
    'timber', 'quarry', 'land', 'environmental',
  ],
  'manufacturing & industrial': [
    'manufacturer', 'manufacturing', 'production', 'fabricat', 'engineering',
    'industrial', 'factory', 'assembly', 'machining', 'toolmaker', 'precision',
    'mechanical', 'electrical', 'chemical', 'plastics', 'metal', 'steel',
    'welding', 'printing', 'packaging',
  ],
  'construction & property': [
    'builder', 'building', 'construction', 'contractor', 'roofing', 'plumbing',
    'groundwork', 'civil', 'fit out', 'refurbishment', 'renovation', 'surveying',
    'estate agent', 'letting', 'property management', 'facilities', 'landscaping',
    'joinery', 'architect', 'scaffolding',
  ],
  'wholesale, retail & e-commerce': [
    'wholesale', 'retail', 'shop', 'store', 'boutique', 'ecommerce', 'e-commerce',
    'trading', 'merchant', 'supplier', 'distributor', 'marketplace', 'online shop',
    'online retail', 'import', 'export', 'amazon', 'shopify',
  ],
  'transport & logistics': [
    'transport', 'logistics', 'haulage', 'courier', 'freight', 'distribution',
    'warehousing', 'delivery', 'fleet', 'removal', 'shipping', 'storage',
    'supply chain', 'taxi', 'coach',
  ],
  'hospitality, leisure & tourism': [
    'hotel', 'restaurant', 'pub', 'cafe', 'bar', 'catering', 'accommodation',
    'bistro', 'guesthouse', 'bed and breakfast', 'takeaway', 'food',
    'leisure', 'fitness', 'gym', 'sport', 'entertainment', 'events',
    'tourism', 'travel', 'holiday', 'recreation', 'attraction', 'wedding venue',
  ],
  'technology & digital': [
    'software', 'tech', 'saas', 'digital', 'data', 'cloud', 'developer',
    'development', 'programming', 'coding', 'platform', 'cyber', 'fintech',
    'website', 'app', 'seo', 'social media', 'digital marketing',
    'web design', 'it services', 'managed services',
  ],
  'financial & professional services': [
    'financial', 'finance', 'accountancy', 'accounting', 'insurance', 'mortgage',
    'wealth', 'investment', 'bookkeeping', 'tax', 'legal', 'solicitor', 'law',
    'recruitment', 'consultancy', 'consulting', 'advisory', 'professional services',
    'outsourcing', 'payroll', 'compliance', 'hr',
  ],
  'health, education & social care': [
    'medical', 'health', 'dental', 'pharmacy', 'clinical', 'therapy', 'nursing',
    'care', 'wellbeing', 'aesthetic', 'residential', 'domiciliary', 'supported living',
    'childcare', 'elderly', 'education', 'school', 'training', 'tutoring',
    'learning', 'nursery', 'academy', 'coaching', 'social care', 'charity',
  ],
  'creative, media & consumer services': [
    'creative', 'media', 'marketing', 'advertising', 'design', 'photography',
    'publishing', 'agency', 'content', 'video', 'film', 'pr', 'branding',
    'print', 'fashion', 'beauty', 'salon', 'spa', 'cleaning', 'laundry',
    'personal services', 'funeral', 'consumer services',
  ],
};

/**
 * Expand a list of buyer sector labels into a flat deduplicated set of
 * search terms for fuzzy substring matching against listing sector + name.
 * Does an exact lookup on the full sector label first, then falls back to
 * individual words so partial / mis-cased labels still get coverage.
 */
function expandSectorKeywords(sectors) {
  const keywords = new Set();
  for (const s of sectors) {
    const normalised = s.toLowerCase().trim();
    // Add the meaningful words from the label itself
    normalised.split(/[\s,/&+]+/).filter((w) => w.length > 2).forEach((w) => keywords.add(w));
    // Add all synonyms for this sector
    (SECTOR_SYNONYMS[normalised] ?? []).forEach((w) => keywords.add(w));
  }
  return [...keywords];
}

// ── Financial soft scoring ────────────────────────────────────────────────────
const FINANCIAL_BOOST   = 0.08; // listing has data AND is within the buyer's range (±leeway)
const FINANCIAL_PENALTY = 0.05; // listing has data AND is clearly outside the buyer's range
const MISSING_PENALTY   = 0.02; // listing has no data for a criterion the buyer specified
const LEEWAY            = 0.50; // ±50% tolerance around the stated range
const SECTOR_BOOST      = 0.15; // listing sector matches buyer's preferred sectors

/**
 * Returns a score adjustment based on how well a listing's financials match
 * the buyer's stated criteria. Only evaluates criteria that the buyer actually
 * specified (degenerate bounds are skipped so missing buyer data never penalises).
 *
 * @param {object} meta     - Pinecone metadata for the listing
 * @param {object} ebitda   - { min, max } parsed from buyer profile
 * @param {object} turnover - { min, max } parsed from buyer profile
 * @param {number} maxPrice - calculated max asking price
 * @returns {{ adjustment: number, breakdown: object }}
 */
function scoreFinancials(meta, ebitda, turnover, maxPrice) {
  let adjustment = 0;
  const breakdown = {};

  function check(label, listingVal, buyerMin, buyerMax) {
    const hasConstraint = buyerMin > 0 || buyerMax < Infinity;
    if (!hasConstraint) return; // buyer didn't specify this criterion

    if (listingVal == null) {
      adjustment -= MISSING_PENALTY;
      breakdown[label] = `missing (−${MISSING_PENALTY})`;
      return;
    }

    const leniMin = buyerMin > 0 ? buyerMin * (1 - LEEWAY) : 0;
    const leniMax = buyerMax < Infinity ? buyerMax * (1 + LEEWAY) : Infinity;

    if (listingVal >= leniMin && listingVal <= leniMax) {
      adjustment += FINANCIAL_BOOST;
      breakdown[label] = `match (+${FINANCIAL_BOOST})`;
    } else {
      adjustment -= FINANCIAL_PENALTY;
      breakdown[label] = `outside range (−${FINANCIAL_PENALTY})`;
    }
  }

  check('ebitda',       meta.ebitda,        ebitda.min,   ebitda.max);
  check('turnover',     meta.turnover,       turnover.min, turnover.max);
  check('asking_price', meta.asking_price,   0,            maxPrice);

  return { adjustment, breakdown };
}

// ── Request handler ───────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const { method, url } = req;

  // ── POST /scrape ────────────────────────────────────────────────────────────
  if (method === 'POST' && url === '/scrape') {
    let body;
    try {
      body = await readBody(req);
    } catch {
      return send(res, 400, { error: 'Request body must be valid JSON' });
    }

    const rawSources = Array.isArray(body.sources) ? body.sources : [body.sources];
    const invalid = rawSources.filter((s) => !SCRAPERS[normaliseKey(s)]);
    if (rawSources.length === 0 || invalid.length > 0) {
      return send(res, 400, {
        error: `Unknown source(s): ${invalid.join(', ')}. Valid values: ${VALID_SOURCES}`,
      });
    }

    const pages = parseInt(body.pages, 10);
    if (isNaN(pages) || pages < 1) {
      return send(res, 400, { error: '"pages" must be a positive integer' });
    }

    const sourceKeys = rawSources.map(normaliseKey);
    console.log(`[API] POST /scrape  sources=[${sourceKeys.join(', ')}]  pages=${pages}`);

    try {
      const results = await Promise.all(
        sourceKeys.map(async (key) => {
          const scraper = SCRAPERS[key]();
          const listings = await scraper.scrape(pages);
          console.log(`[API] ${scraper.name} — ${listings.length} listings`);
          return { name: scraper.name, listings };
        }),
      );

      const listings = results.flatMap((r) => r.listings);
      const by_source = Object.fromEntries(results.map((r) => [r.name, r.listings.length]));

      return send(res, 200, { pages, count: listings.length, by_source, listings });
    } catch (err) {
      console.error(`[API] Scrape failed: ${err.message}`);
      return send(res, 500, { error: 'Scrape failed', detail: err.message });
    }
  }

  // ── POST /api/generate-matches ──────────────────────────────────────────────
  if (method === 'POST' && url === '/api/generate-matches') {
    let body;
    try {
      body = await readBody(req);
    } catch {
      return send(res, 400, { error: 'Request body must be valid JSON' });
    }

    if (!body.user_id) {
      return send(res, 400, { error: 'user_id is required' });
    }

    try {
      // 1. Retrieve buyer profile
      console.log(`[generate-matches] Looking up Buyer_Info for user_id: ${body.user_id}`);
      const profileRes = await getBuyerInfo(body.user_id);
      if (!profileRes || profileRes.count === 0) {
        console.log('[generate-matches] No Buyer_Info found — returning 404');
        return send(res, 404, { error: 'No Buyer_Info found for this user' });
      }
      const p = profileRes.results[0];
      console.log('[generate-matches] Buyer_Info retrieved:', JSON.stringify(p, null, 2));

      // 2. Build hard filter constraints
      const sectors = getField(p, 'industry_preferences_list_option_sectors') ?? [];
      const excl    = getField(p, 'excluded_sectors_list_option_sectors') ?? [];

      const ebitdaRaw   = getField(p, 'ebitda_range', 'ebitda_range_text');
      const turnoverRaw = getField(p, 'turnover_range', 'turnover_range_text');
      const marginRaw   = getField(p, 'ebitda_margin_min', 'ebitda_margin_min_text');
      const budgetRaw   = getField(p, 'initial_budget', 'initial_budget_text');
      const fundingRaw  = getField(p, 'funding_source', 'funding_source_text');

      const ebitda   = parseRange(ebitdaRaw);
      const turnover = parseRange(turnoverRaw);
      const margin   = parsePercent(marginRaw);
      const maxPrice = calcMaxPrice(p);

      console.log('[generate-matches] Raw financial fields:', { ebitdaRaw, turnoverRaw, marginRaw, budgetRaw, fundingRaw });
      console.log('[generate-matches] Parsed values:', {
        sectors,
        excl,
        ebitda,
        turnover,
        margin,
        maxPrice: maxPrice === Infinity ? 'Infinity (no filter)' : maxPrice,
      });

      // 3. Fetch user's existing match history (novelty filter)
      console.log('[generate-matches] Fetching existing match history…');
      const seenIds = await getExistingMatches(body.user_id);
      console.log(`[generate-matches] ${seenIds.length} already-seen business IDs`);

      // 4. Build golden string and vectorise
      const queryText = buildGoldenString(p);
      console.log('[generate-matches] Golden string:', queryText || '(empty — all soft fields blank)');

      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      console.log('[generate-matches] Generating embedding via OpenAI…');
      const embRes = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: queryText || 'business for sale UK',
      });
      const vector = embRes.data[0].embedding;
      console.log(`[generate-matches] Embedding generated (${vector.length} dimensions)`);

      // 5. Query Pinecone — dynamic topK scales with seen history so there are always enough unseen candidates
      const topK = Math.min(Math.max(30, seenIds.length + 15), 100);
      console.log(`[generate-matches] Querying Pinecone (topK=${topK}, includeMetadata=true)…`);
      const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
      const index = pinecone.index(process.env.PINECONE_INDEX_NAME);
      const qRes = await index.query({
        vector,
        topK,
        includeMetadata: true,
      });

      console.log(`[generate-matches] Pinecone returned ${qRes.matches.length} raw candidates`);


      // 6. Sector re-ranking
      //    Primary: exact match against normalised_sectors (set at ingest time by GPT classifier)
      //    Fallback: keyword expansion for listings ingested before the classifier was added
      const sectorKeywords = expandSectorKeywords(sectors);

      const reranked = qRes.matches.map((m) => {
        const normalisedSectors = m.metadata?.normalised_sectors ?? [];
        let sectorMatch;
        if (normalisedSectors.length > 0) {
          // Classified listing — exact intersection with buyer's preferred sectors
          sectorMatch = sectors.length > 0 && normalisedSectors.some((s) => sectors.includes(s));
        } else {
          // Unclassified listing (pre-backfill) — fall back to keyword expansion
          const searchText = [m.metadata?.sector ?? '', m.metadata?.business_name ?? '']
            .join(' ').toLowerCase();
          sectorMatch = sectorKeywords.length > 0 && sectorKeywords.some((kw) => searchText.includes(kw));
        }

        // Financial soft scoring
        const { adjustment: financialAdj, breakdown: financialBreakdown } =
          scoreFinancials(m.metadata ?? {}, ebitda, turnover, maxPrice);

        const adjustedScore = m.score
          + (sectorMatch ? SECTOR_BOOST : 0)
          + financialAdj;

        return { ...m, adjustedScore, sectorMatch, financialAdj, financialBreakdown };
      });

      reranked.sort((a, b) => b.adjustedScore - a.adjustedScore);

      console.log(`[generate-matches] All ${reranked.length} candidates with full metadata:`);
      reranked.forEach((m) =>
        console.log(`  id=${m.id}  score=${m.score.toFixed(4)}  adjusted=${m.adjustedScore.toFixed(4)}  sector=${m.sectorMatch}  financial=${m.financialAdj.toFixed(2)}  breakdown=${JSON.stringify(m.financialBreakdown)}  metadata=${JSON.stringify(m.metadata)}`),
      );

      // 7. Apply threshold + novelty filter + exclusion filter, then take top 5
      //    Exclusion uses normalised_sectors (exact) with keyword fallback for unclassified listings
      const exclKeywords = expandSectorKeywords(excl);
      const noveltyFiltered = reranked.filter((m) => !seenIds.includes(m.id));
      const exclFiltered = noveltyFiltered.filter((m) => {
        if (excl.length === 0) return true;
        const normalisedSectors = m.metadata?.normalised_sectors ?? [];
        if (normalisedSectors.length > 0) {
          return !normalisedSectors.some((s) => excl.includes(s));
        }
        // Fallback for unclassified listings
        const text = [m.metadata?.sector ?? '', m.metadata?.business_name ?? '']
          .join(' ').toLowerCase();
        return !exclKeywords.some((kw) => text.includes(kw));
      });
      console.log(`[generate-matches] ${noveltyFiltered.length - exclFiltered.length} excluded by sector exclusion filter`);

      const passing = exclFiltered
        .filter((m) => m.adjustedScore >= 0.50)
        .slice(0, 5);

      console.log(`[generate-matches] After novelty filter + threshold (adjustedScore>=0.50): ${passing.length} new matches`);
      passing.forEach((m) =>
        console.log(`  id=${m.id}  score=${m.score.toFixed(4)}  adjusted=${m.adjustedScore.toFixed(4)}  sector=${m.sectorMatch}  financial=${m.financialAdj.toFixed(2)}`),
      );

      const matches = passing.map((m) => ({ id: m.id, score: parseFloat(m.adjustedScore.toFixed(4)) }));

      // 8. POST each match individually to Bubble workflow (parallelised)
      if (matches.length > 0) {
        console.log(`[generate-matches] POSTing ${matches.length} matches individually to Bubble create_match workflow…`);
        await Promise.all(
          matches.map((match) =>
            fetch(`${BUBBLE_BASE}/wf/create_match`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.BUBBLE_API_KEY}` },
              body: JSON.stringify({ user_id: body.user_id, business_id: match.id, score: match.score }),
            }).then((wfRes) => {
              if (!wfRes.ok) throw new Error(`create_match returned HTTP ${wfRes.status} for ${match.id}`);
              console.log(`[generate-matches] Created match: business=${match.id} score=${match.score}`);
            }),
          ),
        );
        return send(res, 200, { matched: matches.length, matches });
      } else {
        console.log('[generate-matches] No new unseen matches — skipping Bubble workflow call');
        return send(res, 200, { message: 'No new unseen matches found today above the threshold.' });
      }
    } catch (err) {
      console.error(`[API] generate-matches failed: ${err.message}`);
      return send(res, 500, { error: 'Match generation failed', detail: err.message });
    }
  }

  // ── 404 fallback ────────────────────────────────────────────────────────────
  return send(res, 404, { error: 'Not found. Available: POST /scrape, POST /api/generate-matches' });
});

server.listen(PORT, () => {
  console.log(`Acquiro Scraper API listening on http://localhost:${PORT}`);
  console.log(`POST /scrape               { "sources": "rightbiz|cogogo|daltons|businessesforsale", "pages": 3 }`);
  console.log(`POST /api/generate-matches { "user_id": "<bubble_user_id>" }`);
});
