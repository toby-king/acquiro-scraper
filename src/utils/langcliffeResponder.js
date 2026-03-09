import OpenAI from 'openai';
import { Pinecone } from '@pinecone-database/pinecone';
import {
  getBuyerInfo,
  getAgentForUser,
  checkOutreachExists,
  createOutreachDraft,
  getLangcliffeOutreach,
  approveOutreach,
  rejectOutreach,
} from './bubbleClient.js';
import {
  buildGoldenString,
  scoreFinancials,
  parseRange,
  calcMaxPrice,
  getField,
  expandSectorKeywords,
} from './matcher.js';

const SECTOR_BOOST      = 0.15;
const SCORE_THRESHOLD   = 0.50;

// ── Helpers ───────────────────────────────────────────────────────────────────

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function sanitiseAgentName(name) {
  return (name ?? 'agent')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .replace(/[^a-zA-Z0-9]/g, '')    // remove spaces + special chars
    .toLowerCase() || 'agent';
}

function agentDisplayName(name) {
  const titled = (name ?? 'Agent')
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
  return `${titled} @ Acquiro`;
}

function buildListingGoldenString(listing) {
  const parts = [];
  if (listing.business_name) parts.push(listing.business_name + '.');
  if (listing.sector)        parts.push(`Sector: ${listing.sector}.`);
  if (listing.location)      parts.push(`Location: ${listing.location}.`);
  if (listing.description)   parts.push(listing.description.trim());
  return parts.join(' ') || '(no description)';
}

async function sendViaSendGrid({ from, fromName, to, subject, body }) {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) throw new Error('SENDGRID_API_KEY env var is not set');

  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: from, name: fromName ?? 'Acquiro' },
      subject,
      content: [{ type: 'text/plain', value: body }],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SendGrid returned HTTP ${res.status}: ${text}`);
  }
}

// ── Draft email generation ────────────────────────────────────────────────────

async function generateDraftBody({ listing, buyerProfile, agentName, agentEmail }) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const contactFirstName = listing.langcliffeContactName?.split(' ')[0] ?? 'there';
  const companyOverview  = getField(buyerProfile, 'company_overview_text') ?? '';
  const fundingSource    = getField(buyerProfile, 'funding_source', 'funding_source_text') ?? '';
  const geography        = getField(buyerProfile, 'geography', 'geography_text') ?? 'UK';

  const prompt = `Write a short, professional expression-of-interest email to a business broker.

Broker contact first name: ${contactFirstName}
Listing reference: ${listing.ref_id}
Business type: ${listing.business_name} (${listing.sector}, ${listing.location})
Our company overview: ${companyOverview}
Our funding approach: ${fundingSource}
Agent signing off: ${agentName} | ${agentEmail}

Structure:
1. Brief greeting using the first name.
2. One sentence expressing interest in this specific opportunity (mention reference number and business type).
3. Two to three sentences introducing who we are and our acquisition focus (use the company overview).
4. One sentence on funding / how we approach deals.
5. Ask to proceed: confirm we are happy to review the NDA and look forward to the IM.
6. Professional sign-off with agent name and email.

Keep it concise — under 200 words total. Do NOT include a subject line. Plain text only.`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.4,
  });

  return completion.choices[0].message.content.trim();
}

// ── Scoring ───────────────────────────────────────────────────────────────────

async function scoreListing({ bubbleId, listing, buyerProfile, openai, pineconeIndex }) {
  // Try to fetch the pre-computed listing vector from Pinecone
  let listingVector = null;
  try {
    const fetchRes = await pineconeIndex.fetch([bubbleId]);
    listingVector = fetchRes.records?.[bubbleId]?.values ?? null;
  } catch (err) {
    console.warn(`[langcliffe] Pinecone fetch failed for ${bubbleId}: ${err.message} — falling back to re-embed`);
  }

  if (!listingVector) {
    // Ghost listing or fetch failed — re-embed the listing golden string
    console.warn(`[langcliffe] No Pinecone vector for ${bubbleId}, re-embedding listing`);
    const embRes = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: buildListingGoldenString(listing),
    });
    return { vector: embRes.data[0].embedding, fromPinecone: false };
  }

  return { vector: listingVector, fromPinecone: true };
}

// ── Main exports ──────────────────────────────────────────────────────────────

/**
 * Score Langcliffe listings against the forwarding user's buyer profile.
 * Creates a pending LangcliffeOutreach record for each match ≥ 0.50.
 * Does NOT send — waits for admin approval.
 *
 * @param {{ userId: string, listingsWithBubbleIds: Array<{ bubbleId: string, listing: object }>, langcliffeContact: string }}
 */
export async function processLangcliffeListings({ userId, listingsWithBubbleIds, langcliffeContact, inboundEmail = '' }) {
  // 1. Fetch buyer profile and agent
  const profileRes = await getBuyerInfo(userId);
  if (!profileRes || profileRes.count === 0) {
    console.warn(`[langcliffe] No Buyer_Info for user ${userId} — skipping`);
    return;
  }
  const p = profileRes.results[0];

  const agent = await getAgentForUser(userId);
  if (!agent) {
    console.warn(`[langcliffe] No agent for user ${userId} — skipping`);
    return;
  }

  // 2. Parse buyer constraints
  const sectors      = getField(p, 'industry_preferences_list_option_sectors') ?? [];
  const excl         = getField(p, 'excluded_sectors_list_option_sectors') ?? [];
  const ebitda       = parseRange(getField(p, 'ebitda_range', 'ebitda_range_text'));
  const turnover     = parseRange(getField(p, 'turnover_range', 'turnover_range_text'));
  const maxPrice     = calcMaxPrice(p);
  const sectorKeywords = expandSectorKeywords(sectors);
  const exclKeywords   = expandSectorKeywords(excl);

  // 3. Embed buyer golden string
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const buyerText = buildGoldenString(p);
  const buyerEmbRes = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: buyerText || 'business acquisition UK',
  });
  const buyerVector = buyerEmbRes.data[0].embedding;

  const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
  const pineconeIndex = pinecone.index(process.env.PINECONE_INDEX_NAME);

  const agentName  = agent.name_text ?? agent.name ?? 'Your Agent';
  const agentEmail = agent.email_text ?? null;

  for (const { bubbleId, listing } of listingsWithBubbleIds) {
    const listingId = `langcliffe_${listing.ref_id}`;

    // Dedup: skip if outreach already exists for this user + listing
    const exists = await checkOutreachExists(userId, listingId);
    if (exists) {
      console.log(`[langcliffe] Skipping duplicate outreach for listing ${listingId}, user ${userId}`);
      continue;
    }

    // Get listing vector
    let listingVector;
    try {
      const scored = await scoreListing({ bubbleId, listing, buyerProfile: p, openai, pineconeIndex });
      listingVector = scored.vector;
    } catch (err) {
      console.warn(`[langcliffe] Could not get vector for ${bubbleId}: ${err.message}`);
      continue;
    }

    // Cosine similarity + financial/sector adjustments
    const rawScore = cosineSimilarity(buyerVector, listingVector);

    const searchText = `${listing.sector ?? ''} ${listing.business_name ?? ''}`.toLowerCase();
    const normalisedSectors = []; // Langcliffe listings may not have normalised sectors yet
    const sectorMatch = sectorKeywords.length > 0 && sectorKeywords.some((kw) => searchText.includes(kw));

    const listingMeta = {
      ebitda:       listing.ebitda,
      turnover:     listing.turnover,
      asking_price: null, // no asking price at teaser stage
    };
    const { adjustment: financialAdj } = scoreFinancials(listingMeta, ebitda, turnover, maxPrice);

    const adjustedScore = rawScore + (sectorMatch ? SECTOR_BOOST : 0) + financialAdj;

    // Check sector exclusions
    const excluded = excl.length > 0 && exclKeywords.some((kw) => searchText.includes(kw));

    console.log(`[langcliffe] listing=${listingId} raw=${rawScore.toFixed(3)} adjusted=${adjustedScore.toFixed(3)} sectorMatch=${sectorMatch} excluded=${excluded}`);

    if (excluded || adjustedScore < SCORE_THRESHOLD) {
      console.log(`[langcliffe] Score below threshold or excluded — skipping outreach for ${listingId}`);
      continue;
    }

    // Generate draft email
    let draftBody;
    try {
      draftBody = await generateDraftBody({
        listing: { ...listing, langcliffeContactName: langcliffeContact.split('@')[0].replace('.', ' ') },
        buyerProfile: p,
        agentName,
        agentEmail: agentEmail ?? 'agent@acquiro.ai',
      });
    } catch (err) {
      console.error(`[langcliffe] Draft generation failed for ${listingId}: ${err.message}`);
      continue;
    }

    // Save to Bubble as pending
    try {
      const outreachId = await createOutreachDraft({
        userId,
        listingId,
        langcliffeContact,
        businessName: listing.business_name ?? listingId,
        draftBody,
        inboundEmail,
      });
      console.log(`[langcliffe] Outreach draft created (id=${outreachId}) for listing ${listingId} — awaiting admin approval`);
    } catch (err) {
      console.error(`[langcliffe] Failed to save outreach draft for ${listingId}: ${err.message}`);
    }
  }
}

/**
 * Send an approved outreach email via SendGrid.
 * Called by the admin endpoint when admin clicks Approve.
 *
 * @param {string} outreachId - Bubble LangcliffeOutreach record _id
 */
export async function sendApprovedOutreach(outreachId) {
  const outreach = await getLangcliffeOutreach(outreachId);
  if (!outreach) throw new Error(`LangcliffeOutreach record not found: ${outreachId}`);

  const userId = outreach.user_user;
  const agent  = await getAgentForUser(userId);

  const rawName    = agent?.name_text ?? agent?.name ?? 'agent';
  const fromEmail  = `${sanitiseAgentName(rawName)}@acquiro-agent.com`;
  const fromName   = agentDisplayName(rawName);

  const ref = outreach.listing_id_text?.replace('langcliffe_', '') ?? '';
  const subject = `Acquisition enquiry — Ref ${ref}: ${outreach.business_name_text ?? 'Business opportunity'}`;

  const testRecipient = process.env.LANGCLIFFE_TEST_RECIPIENT;
  const recipient = testRecipient || outreach.langcliffe_contact_text;

  await sendViaSendGrid({
    from:     fromEmail,
    fromName,
    to:       recipient,
    subject,
    body:    outreach.draft_body_text,
  });

  await approveOutreach(outreachId);
  console.log(`[langcliffe] Outreach sent for ${outreach.listing_id_text} → ${recipient}${testRecipient ? ' (test override)' : ''}`);
}

/**
 * Regenerate the draft email with admin feedback and reset status to pending.
 * Called by the admin endpoint when admin clicks Reject.
 *
 * @param {string} outreachId
 * @param {string|undefined} feedback - Optional notes from admin to guide rewrite
 */
export async function rewriteOutreachDraft(outreachId, feedback) {
  const outreach = await getLangcliffeOutreach(outreachId);
  if (!outreach) throw new Error(`LangcliffeOutreach record not found: ${outreachId}`);

  const userId = outreach.user_user;
  const profileRes = await getBuyerInfo(userId);
  const p = profileRes?.results?.[0] ?? {};

  const agent    = await getAgentForUser(userId);
  const agentName  = agent?.name_text ?? agent?.name ?? 'Your Agent';
  const agentEmail = agent?.email_text ?? 'agent@acquiro.ai';

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const contactFirstName = outreach.langcliffe_contact_text?.split('@')[0].replace('.', ' ') ?? 'there';
  const companyOverview  = getField(p, 'company_overview_text') ?? '';
  const fundingSource    = getField(p, 'funding_source', 'funding_source_text') ?? '';
  const ref              = outreach.listing_id_text?.replace('langcliffe-', '') ?? '';

  const feedbackSection = feedback ? `\n\nAdmin feedback on the previous draft:\n"${feedback}"\nPlease address this in the rewrite.` : '';

  const prompt = `Rewrite the following expression-of-interest email. Keep it concise (under 200 words), professional, and plain text only. Do NOT include a subject line.${feedbackSection}

Previous draft:
${outreach.draft_body_text}

Context:
- Broker contact first name: ${contactFirstName}
- Listing reference: ${ref}
- Business: ${outreach.business_name_text ?? 'the business'}
- Our company overview: ${companyOverview}
- Our funding approach: ${fundingSource}
- Agent signing off: ${agentName} | ${agentEmail}`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.4,
  });

  const newDraftBody = completion.choices[0].message.content.trim();
  await rejectOutreach(outreachId, newDraftBody);
  console.log(`[langcliffe] Outreach draft rewritten for ${outreach.listing_id_text}`);
  return newDraftBody;
}
