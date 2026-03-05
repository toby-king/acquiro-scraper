import OpenAI from 'openai';
import { Pinecone } from '@pinecone-database/pinecone';
import { insertListing } from './bubbleClient.js';
import { classifySectors } from './sectorClassifier.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });

const PINECONE_INDEX_NAME = process.env.PINECONE_INDEX_NAME;
if (!PINECONE_INDEX_NAME) throw new Error('PINECONE_INDEX_NAME env var is not set');

const index = pinecone.index(PINECONE_INDEX_NAME);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildGoldenString(data) {
  const parts = [];
  if (data.business_name) parts.push(data.business_name + '.');
  if (data.sector)        parts.push(`Sector: ${data.sector}.`);
  if (data.sub_sector)    parts.push(`Sub-sector: ${data.sub_sector}.`);
  if (data.location)      parts.push(`Location: ${data.location}.`);
  if (data.description)   parts.push(data.description.trim());
  return parts.join(' ') || '(no description)';
}

function buildCleanMetadata(data) {
  const meta = {};

  const numericFields = [
    'asking_price', 'leasehold', 'freehold', 'turnover',
    'net_profit', 'ebit', 'ebitda', 'rent', 'investment', 'franchise_fee',
  ];
  for (const field of numericFields) {
    const val = data[field];
    if (val !== null && val !== undefined && isFinite(val)) {
      meta[field] = val;
    }
  }

  const stringFields = [
    'business_name', 'location', 'region', 'sector', 'sub_sector', 'source', 'url',
  ];
  for (const field of stringFields) {
    const val = data[field];
    if (val !== null && val !== undefined && val !== '') {
      meta[field] = val;
    }
  }

  return meta;
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Insert a scraped listing into Bubble, embed it with OpenAI, and upsert
 * the vector into Pinecone.
 *
 * Failure policy:
 *  - Bubble fails  → throw  (hard abort — caller skips listing)
 *  - OpenAI fails  → warn GHOST LISTING, return bubbleId  (soft)
 *  - Pinecone fails→ warn GHOST LISTING, return bubbleId  (soft)
 *
 * @param {object} scrapedData
 * @returns {Promise<string>} Bubble record ID
 */
export async function processAndIndexListing(scrapedData) {
  // 1. Write to Bubble (hard — must succeed)
  const bubbleResponse = await insertListing(scrapedData);
  const bubbleId = bubbleResponse?.response?._id;
  if (!bubbleId) throw new Error('Bubble returned no _id');

  // 2. Build text to embed
  const goldenString = buildGoldenString(scrapedData);

  // 3. Embed with OpenAI (soft failure)
  let vector;
  try {
    const embeddingResponse = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: goldenString,
    });
    vector = embeddingResponse.data[0].embedding;
  } catch (err) {
    console.warn(`GHOST LISTING — OpenAI embed failed for Bubble ID ${bubbleId}: ${err.message}`);
    return bubbleId;
  }

  // 4. Build clean Pinecone metadata
  const metadata = buildCleanMetadata(scrapedData);

  // 4a. Classify into canonical sectors (soft failure — empty array if it fails)
  const normalisedSectors = await classifySectors(
    scrapedData.business_name,
    scrapedData.sector ?? null,
    scrapedData.description ?? null,
  );
  if (normalisedSectors.length > 0) {
    metadata.normalised_sectors = normalisedSectors;
  }
  console.log(`[indexer] normalised_sectors for "${scrapedData.business_name}": [${normalisedSectors.join(', ')}]`);

  // 5. Upsert into Pinecone (soft failure)
  try {
    await index.upsert({ records: [{ id: bubbleId, values: vector, metadata }] });
  } catch (err) {
    console.warn(`GHOST LISTING — Pinecone upsert failed for Bubble ID ${bubbleId}: ${err.message}`);
  }

  return bubbleId;
}
