import OpenAI from 'openai';

/**
 * The canonical sector labels — must exactly match the Bubble option set values
 * so that normalised_sectors can be compared directly against buyer preferences.
 */
export const SECTOR_LABELS = [
  'Agriculture & Natural Resources',
  'Manufacturing & Industrial',
  'Construction & Property',
  'Wholesale, Retail & E-commerce',
  'Transport & Logistics',
  'Hospitality, Leisure & Tourism',
  'Technology & Digital',
  'Financial & Professional Services',
  'Health, Education & Social Care',
  'Creative, Media & Consumer Services',
];

const SECTOR_LIST = SECTOR_LABELS.map((s, i) => `${i + 1}. ${s}`).join('\n');

const SYSTEM_PROMPT = `You are a business acquisition sector classifier.
Given a business listing, return a JSON object {"sectors": [...]} containing the matching sector labels.

Choose from this exact list only:
${SECTOR_LIST}

Rules:
- Use the exact label text as shown above
- Return 1–3 sectors (most businesses fit 1–2)
- Return {"sectors": []} if genuinely none apply
- Do not invent or paraphrase sector names`;

/**
 * Classify a listing into one or more of the 10 canonical Bubble sector labels.
 * Returns an empty array on error — caller should continue with no normalised_sectors
 * rather than blocking ingestion.
 *
 * @param {string}      businessName
 * @param {string|null} rawSector    Raw sector string from the scraper (may be null)
 * @param {string|null} description  Listing description (truncated to 300 chars)
 * @returns {Promise<string[]>}
 */
export async function classifySectors(businessName, rawSector, description) {
  const parts = [`Business name: ${businessName}`];
  if (rawSector)    parts.push(`Raw sector: ${rawSector}`);
  if (description)  parts.push(`Description: ${String(description).slice(0, 300)}`);

  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: parts.join('\n') },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 100,
    });

    const parsed = JSON.parse(res.choices[0].message.content);
    const arr = Array.isArray(parsed.sectors) ? parsed.sectors : [];

    // Guard: only return labels that exist in the canonical list
    return arr.filter((s) => SECTOR_LABELS.includes(s));
  } catch (err) {
    console.warn(`[classifySectors] Failed for "${businessName}": ${err.message}`);
    return [];
  }
}
