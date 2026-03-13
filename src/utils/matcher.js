/**
 * Reusable matching logic — extracted from server.js so it can be called
 * both from the HTTP handler and from the daily pipeline runner.
 */

import OpenAI from 'openai';
import { Pinecone } from '@pinecone-database/pinecone';
import { getBuyerInfo, getExistingMatches, getDismissedMatchesWithReasons } from './bubbleClient.js';

const BUBBLE_BASE = 'https://toby-85612.bubbleapps.io/version-test/api/1.1';

// ── Helpers ───────────────────────────────────────────────────────────────────

export function getField(profile, ...keys) {
  for (const key of keys) {
    const v = profile[key];
    if (v == null) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    return v;
  }
  return null;
}

export function parseMoney(text) {
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

export function parseRange(text) {
  if (!text || String(text).trim() === '') return { min: 0, max: Infinity };
  const lower = text.toLowerCase();
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
  const val = tokens[0];
  if (/over|above|more than|\+/.test(lower)) return { min: val, max: Infinity };
  if (/up to|under|below/.test(lower))       return { min: 0,   max: val };
  return { min: val, max: Infinity };
}

function parsePercent(text) {
  if (!text) return null;
  const match = String(text).match(/(\d+\.?\d*)\s*%/);
  return match ? parseFloat(match[1]) / 100 : null;
}

export function calcMaxPrice(profile) {
  const budget = parseMoney(getField(profile, 'initial_budget', 'initial_budget_text'));
  if (budget == null) return Infinity;
  const src = (getField(profile, 'funding_source', 'funding_source_text') ?? '').toLowerCase();
  let multiplier = 1;
  if (/debt|financ/.test(src))  multiplier = 3;
  else if (/seller/.test(src))  multiplier = 2;
  return budget * multiplier;
}

export function buildGoldenString(p) {
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

export function expandSectorKeywords(sectors) {
  const keywords = new Set();
  for (const s of sectors) {
    const normalised = s.toLowerCase().trim();
    normalised.split(/[\s,/&+]+/).filter((w) => w.length > 2).forEach((w) => keywords.add(w));
    (SECTOR_SYNONYMS[normalised] ?? []).forEach((w) => keywords.add(w));
  }
  return [...keywords];
}

const FINANCIAL_BOOST        = 0.12;   // reward for in-range (was 0.08)
const FINANCIAL_PENALTY_BASE = 0.07;   // penalty per doubling outside range
const FINANCIAL_PENALTY_CAP  = 0.35;   // max penalty per financial field
const MISSING_PENALTY        = 0.08;   // missing data when buyer has constraint (was 0.02)
const LEEWAY                 = 0.20;
const SECTOR_BOOST           = 0.15;

/**
 * Analyse a user's dismissed-with-reason matches to produce per-user scoring adjustments.
 *
 * @param {Array<{ businessId: string, reason: string }>} dismissedMatches
 * @param {import('@pinecone-database/pinecone').Index} pineconeIndex  Used to fetch sector metadata for wrong_sector dismissals
 * @returns {Promise<{ priceMultiplier: number, feedbackExcludedSectors: string[] }>}
 */
export async function buildFeedbackAdjustments(dismissedMatches, pineconeIndex) {
  const wrongPriceCount = dismissedMatches.filter((d) => d.reason === 'wrong_price').length;

  const wrongSectorIds = [
    ...new Set(
      dismissedMatches
        .filter((d) => d.reason === 'wrong_sector')
        .map((d) => d.businessId)
        .filter(Boolean),
    ),
  ];

  // Only build sector exclusions once we have 2+ wrong_sector signals
  let feedbackExcludedSectors = [];
  if (wrongSectorIds.length >= 2) {
    try {
      const fetched = await pineconeIndex.fetch(wrongSectorIds);
      const sectorCounts = {};
      for (const record of Object.values(fetched.records ?? {})) {
        for (const s of record.metadata?.normalised_sectors ?? []) {
          sectorCounts[s] = (sectorCounts[s] ?? 0) + 1;
        }
      }
      // Only exclude a sector if at least 2 dismissals hit it
      feedbackExcludedSectors = Object.entries(sectorCounts)
        .filter(([, count]) => count >= 2)
        .map(([sector]) => sector);
    } catch (err) {
      console.warn('[feedback] Failed to fetch Pinecone metadata for sector exclusions:', err.message);
    }
  }

  return {
    priceMultiplier: wrongPriceCount >= 2 ? 0.8 : 1.0,
    feedbackExcludedSectors,
  };
}

export function scoreFinancials(meta, ebitda, turnover, maxPrice) {
  let adjustment = 0;
  const breakdown = {};

  function check(label, listingVal, buyerMin, buyerMax) {
    const hasConstraint = buyerMin > 0 || buyerMax < Infinity;
    if (!hasConstraint) return;
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
      // Proportional penalty — scales with how far outside range
      let ratio;
      if (listingVal < leniMin) {
        ratio = leniMin / listingVal;   // e.g. £960k / £137k = 7.0×
      } else {
        ratio = listingVal / leniMax;   // above range
      }
      const penalty = Math.min(Math.log2(ratio) * FINANCIAL_PENALTY_BASE, FINANCIAL_PENALTY_CAP);
      adjustment -= penalty;
      const dir = listingVal < leniMin ? 'below' : 'above';
      breakdown[label] = `${dir} range ×${ratio.toFixed(1)} (−${penalty.toFixed(3)})`;
    }
  }

  check('ebitda',       meta.ebitda,      ebitda.min,   ebitda.max);
  check('turnover',     meta.turnover,     turnover.min, turnover.max);
  check('asking_price', meta.asking_price, 0,            maxPrice);

  return { adjustment, breakdown };
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Generate matches for a single user and persist them to Bubble.
 *
 * @param {string} userId  - Bubble user _id
 * @returns {{ matched: number, matches: Array }} or { message: string } if no new matches
 * @throws on hard errors
 */
export async function generateMatchesForUser(userId) {
  // 1. Retrieve buyer profile
  console.log(`[generate-matches] Looking up Buyer_Info for user_id: ${userId}`);
  const profileRes = await getBuyerInfo(userId);
  if (!profileRes || profileRes.count === 0) {
    throw new Error(`No Buyer_Info found for user ${userId}`);
  }
  const p = profileRes.results[0];

  // 2. Parse constraints
  const sectors = getField(p, 'industry_preferences_list_option_sectors') ?? [];
  const excl    = getField(p, 'excluded_sectors_list_option_sectors') ?? [];

  const ebitdaRaw   = getField(p, 'ebitda_range', 'ebitda_range_text');
  const turnoverRaw = getField(p, 'turnover_range', 'turnover_range_text');
  const ebitda      = parseRange(ebitdaRaw);
  const turnover    = parseRange(turnoverRaw);
  let maxPrice      = calcMaxPrice(p);

  // 3. Fetch existing matches (novelty filter)
  const seenIds = await getExistingMatches(userId);
  console.log(`[generate-matches] ${seenIds.length} already-seen business IDs for user ${userId}`);

  // 4. Build golden string and embed
  const queryText = buildGoldenString(p);
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const embRes = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: queryText || 'business for sale UK',
  });
  const vector = embRes.data[0].embedding;

  // 5. Query Pinecone
  const topK = Math.min(Math.max(30, seenIds.length + 15), 100);
  const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
  const index = pinecone.index(process.env.PINECONE_INDEX_NAME);
  const [qRes, dismissedMatches] = await Promise.all([
    index.query({ vector, topK, includeMetadata: true, filter: { source: { '$ne': 'langcliffe' } } }),
    getDismissedMatchesWithReasons(userId),
  ]);

  // 5a. Build per-user feedback adjustments
  const { priceMultiplier, feedbackExcludedSectors } =
    await buildFeedbackAdjustments(dismissedMatches, index);
  if (priceMultiplier < 1) {
    maxPrice = isFinite(maxPrice) ? maxPrice * priceMultiplier : maxPrice;
    console.log(`[generate-matches] Feedback: price ceiling tightened by ${Math.round((1 - priceMultiplier) * 100)}% → ${maxPrice}`);
  }
  if (feedbackExcludedSectors.length > 0) {
    console.log(`[generate-matches] Feedback: excluding sectors from dismissals: ${feedbackExcludedSectors.join(', ')}`);
  }
  const effectiveExcl = [...new Set([...excl, ...feedbackExcludedSectors])];

  // 6. Sector re-ranking
  const sectorKeywords = expandSectorKeywords(sectors);
  const reranked = qRes.matches.map((m) => {
    const normalisedSectors = m.metadata?.normalised_sectors ?? [];
    let sectorMatch;
    if (normalisedSectors.length > 0) {
      sectorMatch = sectors.length > 0 && normalisedSectors.some((s) => sectors.includes(s));
    } else {
      const searchText = [m.metadata?.sector ?? '', m.metadata?.business_name ?? '']
        .join(' ').toLowerCase();
      sectorMatch = sectorKeywords.length > 0 && sectorKeywords.some((kw) => searchText.includes(kw));
    }
    const { adjustment: financialAdj, breakdown: financialBreakdown } =
      scoreFinancials(m.metadata ?? {}, ebitda, turnover, maxPrice);
    const adjustedScore = m.score + (sectorMatch ? SECTOR_BOOST : 0) + financialAdj;
    return { ...m, adjustedScore, sectorMatch, financialAdj, financialBreakdown };
  });
  reranked.sort((a, b) => b.adjustedScore - a.adjustedScore);

  // 6a. Hard pre-filters: exclude listings that are wildly out of financial range
  const financiallyViable = reranked.filter((m) => {
    const meta = m.metadata ?? {};
    // Turnover must exceed EBITDA minimum (profit can't exceed revenue)
    if (ebitda.min > 0 && meta.turnover != null) {
      if (meta.turnover < ebitda.min) return false;
    }
    // Exclude if known EBITDA is more than 4× below buyer's minimum
    if (ebitda.min > 0 && meta.ebitda != null) {
      if (meta.ebitda < ebitda.min * 0.25) return false;
    }
    // Exclude if known turnover is more than 4× below buyer's minimum
    if (turnover.min > 0 && meta.turnover != null) {
      if (meta.turnover < turnover.min * 0.25) return false;
    }
    return true;
  });

  // 7. Apply novelty + exclusion + threshold filters, take top 5
  const exclKeywords = expandSectorKeywords(effectiveExcl);
  const noveltyFiltered = financiallyViable.filter((m) => !seenIds.includes(m.id));
  const exclFiltered = noveltyFiltered.filter((m) => {
    if (effectiveExcl.length === 0) return true;
    const normalisedSectors = m.metadata?.normalised_sectors ?? [];
    if (normalisedSectors.length > 0) {
      return !normalisedSectors.some((s) => effectiveExcl.includes(s));
    }
    const text = [m.metadata?.sector ?? '', m.metadata?.business_name ?? ''].join(' ').toLowerCase();
    return !exclKeywords.some((kw) => text.includes(kw));
  });

  const passing = exclFiltered.filter((m) => m.adjustedScore >= 0.50).slice(0, 5);

  const matches = passing.map((m) => ({ id: m.id, score: parseFloat(m.adjustedScore.toFixed(4)) }));

  // 8. POST matches to Bubble
  if (matches.length === 0) {
    return { message: 'No new unseen matches found today above the threshold.' };
  }

  await Promise.all(
    matches.map((match) =>
      fetch(`${BUBBLE_BASE}/obj/matches`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.BUBBLE_API_KEY}`,
        },
        body: JSON.stringify({
          user_user: userId,
          business_custom_business: match.id,
          score_number: match.score,
        }),
      }).then((res) => {
        if (!res.ok) throw new Error(`create_match returned HTTP ${res.status} for ${match.id}`);
        console.log(`[generate-matches] Created match: business=${match.id} score=${match.score}`);
      }),
    ),
  );

  return { matched: matches.length, matches };
}
