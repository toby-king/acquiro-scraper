import OpenAI from 'openai';

/**
 * Detects and parses Langcliffe deal teasers from forwarded emails.
 *
 * @param {string} emailText - Plain-text body of the inbound email
 * @returns {Promise<{ langcliffeEmail: string, listings: Array }|null>}
 *   null if this is not a Langcliffe teaser email
 */
export async function parseLangcliffeEmail(emailText) {
  if (!emailText || !emailText.includes('langcliffeinternational.com')) return null;

  // Extract Langcliffe contact email from the quoted chain
  const emailMatches = emailText.match(/[\w.+-]+@langcliffeinternational\.com/gi);
  const langcliffeEmail = emailMatches?.[0]?.toLowerCase() ?? null;

  if (!langcliffeEmail) {
    console.warn('[langcliffe] Found langcliffeinternational.com domain but could not extract contact email');
    return null;
  }

  // Use OpenAI to extract structured listing data from the innermost teaser
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `You extract business acquisition opportunity details from Langcliffe International deal teaser emails.

The email may be a forwarded thread with multiple levels of quoting. Focus on the innermost/original Langcliffe teaser content.

Extract ALL distinct listings mentioned. For each listing return:
- ref_id: the Langcliffe reference number as a string of digits only (e.g. "288658")
- business_name: name or descriptive type of the business
- sector: industry sector
- location: UK location
- turnover: most recent annual turnover as a plain number in GBP (null if not stated)
- ebitda: EBITDA as a plain number in GBP (null if not stated)
- description: concise description of the business (2-4 sentences)

Return JSON: { "listings": [ { "ref_id": "...", "business_name": "...", "sector": "...", "location": "...", "turnover": null, "ebitda": null, "description": "..." } ] }
If no valid teaser is found, return { "listings": [] }.`,
      },
      {
        role: 'user',
        content: emailText.slice(0, 8000),
      },
    ],
    temperature: 0,
  });

  let parsed;
  try {
    parsed = JSON.parse(completion.choices[0].message.content);
  } catch {
    console.warn('[langcliffe] Failed to parse OpenAI JSON response');
    return null;
  }

  const listings = (parsed.listings ?? []).filter((l) => l.ref_id);
  if (listings.length === 0) return null;

  console.log(`[langcliffe] Parsed ${listings.length} listing(s) from email — contact: ${langcliffeEmail}`);
  return { langcliffeEmail, listings };
}
