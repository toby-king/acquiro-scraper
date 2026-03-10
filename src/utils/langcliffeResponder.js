import OpenAI from 'openai';
import { Pinecone } from '@pinecone-database/pinecone';
import {
  getBuyerInfo,
  getUserDetails,
  getAgentForUser,
  checkOutreachExists,
  createOutreachDraft,
  getLangcliffeOutreach,
  approveOutreach,
  rejectOutreach,
  updateOutreachReply,
  approveReply,
  updateReplyDraft,
  updateOutreachNDA,
  approveAcknowledgment,
  storeSignedNDA,
  updateNDAReturnDraft,
  approveNDAReturn,
  createUserNotification,
  getExistingUserNotification,
  updateUserNotification,
  uploadFileToBubble,
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

/**
 * Extract the company name from a company overview string.
 * Looks for a proper noun at the start, or the first capitalised multi-word phrase.
 * Falls back to "our client" if nothing useful is found.
 */
function extractCompanyName(overview) {
  if (!overview) return null;
  // Common patterns: "Acme Ltd is...", "Acme Limited is...", "Acme Group..."
  const match = overview.match(/^([A-Z][A-Za-z0-9&' ]{1,50?}(?:Ltd|Limited|Group|Holdings|Inc|LLP|LLC|PLC|plc)?)\b/);
  if (match) return match[1].trim();
  // Fallback: first capitalised word sequence before a verb
  const fallback = overview.match(/^([A-Z][a-zA-Z0-9 &']{2,40})\s+(?:is |are |was |has |have |provides|offers|operates|specialises|acquires)/);
  if (fallback) return fallback[1].trim();
  return null;
}

function buildListingGoldenString(listing) {
  const parts = [];
  if (listing.business_name) parts.push(listing.business_name + '.');
  if (listing.sector)        parts.push(`Sector: ${listing.sector}.`);
  if (listing.location)      parts.push(`Location: ${listing.location}.`);
  if (listing.description)   parts.push(listing.description.trim());
  return parts.join(' ') || '(no description)';
}

function generateMessageId(fromDomain = 'acquiro-agent.com') {
  const ts  = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `<${ts}.${rnd}@${fromDomain}>`;
}

async function sendViaSendGrid({ from, fromName, to, subject, body, messageId = null, inReplyTo = null }) {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) throw new Error('SENDGRID_API_KEY env var is not set');

  const payload = {
    personalizations: [{ to: [{ email: to }] }],
    from: { email: from, name: fromName ?? 'Acquiro' },
    subject,
    content: [{ type: 'text/plain', value: body }],
  };

  // Add threading headers when available
  const extraHeaders = {};
  if (messageId)  extraHeaders['Message-ID']  = messageId;
  if (inReplyTo)  extraHeaders['In-Reply-To'] = inReplyTo;
  if (inReplyTo)  extraHeaders['References']  = inReplyTo;
  if (Object.keys(extraHeaders).length > 0) payload.headers = extraHeaders;

  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
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
  const companyName      = extractCompanyName(companyOverview) ?? 'our client';
  const fundingSource    = getField(buyerProfile, 'funding_source', 'funding_source_text') ?? '';
  const geography        = getField(buyerProfile, 'geography', 'geography_text') ?? 'UK';

  const prompt = `Write a short, professional expression-of-interest email to a business broker.

Broker contact first name: ${contactFirstName}
Listing reference: ${listing.ref_id}
Business type: ${listing.business_name} (${listing.sector}, ${listing.location})
Writing on behalf of: ${companyName}
Company overview: ${companyOverview}
Funding approach: ${fundingSource}
Agent signing off: ${agentName} | ${agentEmail}

Structure:
1. Brief greeting using the first name.
2. One sentence expressing interest in this specific opportunity (mention reference number and business type). State you are writing on behalf of ${companyName}.
3. Two to three sentences introducing ${companyName} and their acquisition focus (use the company overview).
4. One sentence on funding / how they approach deals.
5. Ask to proceed: confirm you are happy to review the NDA and look forward to the IM.
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

  const messageId = generateMessageId(fromEmail.split('@')[1] ?? 'acquiro-agent.com');

  await sendViaSendGrid({
    from:      fromEmail,
    fromName,
    to:        recipient,
    subject,
    body:      outreach.draft_body_text,
    messageId,
  });

  await approveOutreach(outreachId, messageId);
  console.log(`[langcliffe] Outreach sent for ${outreach.listing_id_text} → ${recipient}${testRecipient ? ' (test override)' : ''}`);
}

// ── Reply handling ────────────────────────────────────────────────────────────

async function generateReplyBody({ outreach, inboundMessage, buyerProfile, agentName, agentEmail }) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const contactFirstName = outreach.langcliffe_contact_text
    ?.match(/<([^>]+)>/)?.[1]?.split('@')[0]?.replace(/[._-]/g, ' ')
    ?? outreach.langcliffe_contact_text?.split('@')[0]?.replace(/[._-]/g, ' ')
    ?? 'there';

  const companyOverview = getField(buyerProfile, 'company_overview_text') ?? '';
  const companyName     = extractCompanyName(companyOverview) ?? 'our client';

  const conversationHistory = outreach.conversation_history_text ?? '';
  const historySection = conversationHistory
    ? `Conversation history so far:\n${conversationHistory}\n\n`
    : `Your original expression of interest:\n${outreach.draft_body_text}\n\n`;

  const prompt = `You are ${agentName}, an M&A acquisition advisor writing on behalf of ${companyName}. You are in an email conversation with a business broker at Langcliffe International about the opportunity "${outreach.business_name_text}".

${historySection}The broker (${contactFirstName}) has now replied:
"${inboundMessage}"

Write a concise, professional reply (under 150 words). Plain text only, no subject line. Respond naturally and appropriately to whatever they have said — whether it's a question, asking for more info, sending an NDA, confirming next steps, or anything else. When referring to the acquiring company, use "${companyName}". Sign off: ${agentName} | ${agentEmail}`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.4,
  });

  return completion.choices[0].message.content.trim();
}

function buildConversationHistory({ existing, agentName, langcliffeReply, replyDraft }) {
  const date = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const base = existing || '';
  const langcliffeBlock = `[${date}] Langcliffe → ${agentName}:\n${langcliffeReply}`;
  const agentBlock = `[Pending] ${agentName} → Langcliffe:\n${replyDraft}`;
  return base ? `${base}\n\n---\n\n${langcliffeBlock}\n\n---\n\n${agentBlock}` : `${langcliffeBlock}\n\n---\n\n${agentBlock}`;
}

/**
 * Called when a Langcliffe contact replies to an outreach email.
 * Generates a reply draft and queues it for admin approval.
 */
export async function handleLangcliffeReply({ outreach, inboundMessage, userId }) {
  const agent = await getAgentForUser(userId);
  const agentName  = agent?.name_text ?? agent?.name ?? 'Your Agent';
  const agentEmail = agent?.email_text ?? 'agent@acquiro.ai';

  const profileRes   = await getBuyerInfo(userId);
  const buyerProfile = profileRes?.results?.[0] ?? {};

  const replyDraft = await generateReplyBody({ outreach, inboundMessage, buyerProfile, agentName, agentEmail });

  const conversationHistory = buildConversationHistory({
    existing:       outreach.conversation_history_text ?? '',
    agentName,
    langcliffeReply: inboundMessage,
    replyDraft,
  });

  await updateOutreachReply({
    outreachId:          outreach._id,
    langcliffeReplyBody: inboundMessage,
    replyDraft,
    conversationHistory,
  });

  console.log(`[langcliffe] Reply draft queued for outreach ${outreach._id} — awaiting admin approval`);
}

/**
 * Send an approved reply to a Langcliffe contact.
 */
export async function sendApprovedReply(outreachId) {
  const outreach = await getLangcliffeOutreach(outreachId);
  if (!outreach) throw new Error(`LangcliffeOutreach record not found: ${outreachId}`);
  if (!outreach.reply_draft_text) throw new Error(`No reply draft on outreach: ${outreachId}`);

  const userId = outreach.user_user;
  const agent  = await getAgentForUser(userId);

  const rawName   = agent?.name_text ?? agent?.name ?? 'agent';
  const fromEmail = `${sanitiseAgentName(rawName)}@acquiro-agent.com`;
  const fromName  = agentDisplayName(rawName);

  const ref     = outreach.listing_id_text?.replace('langcliffe_', '') ?? '';
  const subject = `RE: Acquisition enquiry — Ref ${ref}: ${outreach.business_name_text ?? 'Business opportunity'}`;

  const testRecipient = process.env.LANGCLIFFE_TEST_RECIPIENT;
  const recipient     = testRecipient || outreach.langcliffe_contact_text;

  await sendViaSendGrid({
    from:       fromEmail,
    fromName,
    to:         recipient,
    subject,
    body:       outreach.reply_draft_text,
    inReplyTo:  outreach.thread_message_id_text ?? null,
  });

  // Mark the pending block in conversation history as sent
  const date = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const updatedHistory = (outreach.conversation_history_text ?? '').replace('[Pending]', `[${date}]`);

  await approveReply(outreachId, updatedHistory);
  console.log(`[langcliffe] Reply sent for ${outreach.listing_id_text} → ${recipient}${testRecipient ? ' (test override)' : ''}`);
}

/**
 * Regenerate a reply draft with admin feedback.
 */
export async function rewriteReplyDraft(outreachId, feedback) {
  const outreach = await getLangcliffeOutreach(outreachId);
  if (!outreach) throw new Error(`LangcliffeOutreach record not found: ${outreachId}`);

  const userId       = outreach.user_user;
  const agent        = await getAgentForUser(userId);
  const agentName    = agent?.name_text ?? agent?.name ?? 'Your Agent';
  const agentEmail   = agent?.email_text ?? 'agent@acquiro.ai';
  const profileRes   = await getBuyerInfo(userId);
  const buyerProfile = profileRes?.results?.[0] ?? {};

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const feedbackSection = feedback ? `\n\nAdmin feedback on the previous reply:\n"${feedback}"\nPlease address this in the rewrite.` : '';
  const contactFirstName = outreach.langcliffe_contact_text?.split('@')[0]?.replace(/[._-]/g, ' ') ?? 'there';
  const companyOverview  = getField(buyerProfile, 'company_overview_text') ?? '';
  const companyName      = extractCompanyName(companyOverview) ?? 'our client';

  const prompt = `Rewrite the following reply email. Keep it concise (under 150 words), professional, and plain text only. No subject line.${feedbackSection}

Previous reply draft:
${outreach.reply_draft_text}

Context:
- Broker contact: ${contactFirstName}
- Business: ${outreach.business_name_text ?? 'the business'}
- Their message we're replying to: ${outreach.langcliffe_reply_body_text ?? '(see conversation)'}
- Writing on behalf of: ${companyName}
- Company overview: ${companyOverview}
- Agent signing off: ${agentName} | ${agentEmail}`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.4,
  });

  const newReplyDraft = completion.choices[0].message.content.trim();

  // Update reply draft and rebuild the pending block in conversation history
  const updatedHistory = (outreach.conversation_history_text ?? '')
    .replace(/\[Pending\].*$/s, `[Pending] ${agentName} → Langcliffe:\n${newReplyDraft}`);

  await updateOutreachReply({
    outreachId:          outreachId,
    langcliffeReplyBody: outreach.langcliffe_reply_body_text ?? '',
    replyDraft:          newReplyDraft,
    conversationHistory: updatedHistory,
  });

  console.log(`[langcliffe] Reply draft rewritten for ${outreach.listing_id_text}`);
  return newReplyDraft;
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
  const companyName      = extractCompanyName(companyOverview) ?? 'our client';
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
- Writing on behalf of: ${companyName}
- Company overview: ${companyOverview}
- Funding approach: ${fundingSource}
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

// ── NDA handling ──────────────────────────────────────────────────────────────

async function generateAcknowledgmentBody({ outreach, agentName, agentEmail, isReplacement = false, replacementContext = '' }) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const contactFirstName = outreach.langcliffe_contact_text
    ?.match(/<([^>]+)>/)?.[1]?.split('@')[0]?.replace(/[._-]/g, ' ')
    ?? outreach.langcliffe_contact_text?.split('@')[0]?.replace(/[._-]/g, ' ')
    ?? 'there';
  const ref = outreach.listing_id_text?.replace('langcliffe_', '') ?? '';

  const replacementNote = isReplacement && replacementContext
    ? `\n\nContext: The broker is sending a replacement/updated NDA. Their message explaining why:\n"${replacementContext.trim().substring(0, 400)}"`
    : '';

  const contentInstruction = isReplacement
    ? `Content: Acknowledge receipt of the updated/replacement NDA. Reference that they mentioned sending a new version and confirm you have received it. Confirm you will review it with the client and revert shortly. Express continued interest. Professional sign-off.`
    : `Content: Thank them for sending the NDA. Confirm you will review it with the client and revert shortly. Express continued interest. Professional sign-off.`;

  const prompt = `Write a short, professional acknowledgment email to a business broker confirming receipt of an NDA.

Broker first name: ${contactFirstName}
Business opportunity reference: ${ref}
Business name: ${outreach.business_name_text ?? 'the business'}
Agent signing off: ${agentName} | ${agentEmail}${replacementNote}

${contentInstruction}

Under 100 words. Plain text only. No subject line.`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.4,
  });

  return completion.choices[0].message.content.trim();
}

async function generateNDAReturnBody({ outreach, agentName, agentEmail }) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const contactFirstName = outreach.langcliffe_contact_text
    ?.match(/<([^>]+)>/)?.[1]?.split('@')[0]?.replace(/[._-]/g, ' ')
    ?? outreach.langcliffe_contact_text?.split('@')[0]?.replace(/[._-]/g, ' ')
    ?? 'there';
  const ref = outreach.listing_id_text?.replace('langcliffe_', '') ?? '';

  const prompt = `Write a short, professional email returning a signed NDA to a business broker.

Broker first name: ${contactFirstName}
Business opportunity reference: ${ref}
Business name: ${outreach.business_name_text ?? 'the business'}
Agent signing off: ${agentName} | ${agentEmail}

Content: Confirm the signed NDA is attached. Express that you look forward to reviewing the Information Memorandum. Professional sign-off.

Under 80 words. Plain text only. No subject line.`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.4,
  });

  return completion.choices[0].message.content.trim();
}

/**
 * Called when a Langcliffe reply has a PDF attachment — treat as NDA.
 * Uploads the PDF to Bubble, generates acknowledgment draft, notifies user.
 */
async function generateUserNDAEmail({ outreach, inboundMessage, agentName, agentEmail, buyerProfile }) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const listingRef        = outreach.listing_id_text?.replace('langcliffe_', '') ?? '';
  const businessName      = outreach.business_name_text ?? 'a business opportunity';
  const originalTeaser    = outreach.inbound_email_text ?? '';
  const conversationSoFar = outreach.conversation_history_text ?? '';
  const brokerReply       = outreach.langcliffe_reply_body_text ?? '';
  const companyOverview   = getField(buyerProfile, 'company_overview_text') ?? '';

  // Build a context block from whatever we know about the business
  const contextParts = [];
  if (originalTeaser) contextParts.push(`Original broker teaser:\n${originalTeaser}`);
  if (brokerReply)    contextParts.push(`Broker's reply to our initial outreach:\n${brokerReply}`);
  if (conversationSoFar) contextParts.push(`Conversation history:\n${conversationSoFar}`);
  if (inboundMessage) contextParts.push(`Email accompanying the NDA:\n${inboundMessage}`);
  const contextBlock = contextParts.join('\n\n---\n\n');

  const prompt = `You are ${agentName}, an AI acquisition advisor at Acquiro. You have been quietly working on behalf of a client — they set up their acquisition criteria and trusted you to act on their behalf. They don't yet know about this specific opportunity.

You need to write them an email that:
1. Introduces yourself and briefly reminds them that you've been working on their behalf (they set their criteria and you've been actively pursuing matches for them)
2. Introduces this specific business opportunity — ${businessName} (Ref ${listingRef}) — with a concise but compelling summary of what it is and why it's relevant to their acquisition goals
3. Summarises what's happened so far: you identified the opportunity, reached out to the broker (Langcliffe International), and they've responded positively
4. Shares any useful information learned through the conversation with the broker (beyond the initial listing) — but don't overwhelm them
5. Explains clearly that to move forward and receive the full Information Memorandum (IM), they need to sign an NDA — and that it's ready and waiting for them on their Acquiro dashboard
6. Ends with a warm, confident sign-off as their advisor

Tone: warm but professional. Like a trusted advisor giving an exciting update. Concise — under 250 words. Plain text only, no markdown. No subject line.

Their acquisition focus: ${companyOverview || 'UK business acquisitions'}

All context from the broker interaction:
${contextBlock || '(No prior conversation — this is the first response from the broker)'}

Sign off as: ${agentName} | ${agentEmail}`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.5,
  });

  return completion.choices[0].message.content.trim();
}

// ── IM (Information Memorandum) handling ──────────────────────────────────────

/**
 * Returns true if the email looks like an IM delivery — contains a URL,
 * mentions "IM" or "information memorandum", and includes a password.
 */
export function detectIM(emailText) {
  if (!emailText) return false;
  const lower = emailText.toLowerCase();
  const hasImMention = lower.includes('information memorandum') || /\bim\b/.test(lower);
  const hasUrl       = /https?:\/\/\S+/.test(emailText);
  const hasPassword  = lower.includes('password');
  return hasImMention && hasUrl && hasPassword;
}

/**
 * Extract the IM URL and password from the email body.
 */
function extractIMDetails(emailText) {
  const urlMatch = emailText.match(/https?:\/\/[^\s)>]+/);
  const url = urlMatch ? urlMatch[0].replace(/[.,;]$/, '') : null;

  // Matches: "password is: abc123", "password to access the IM is: abc123", "The password is abc123"
  const passwordMatch = emailText.match(/password[^:\n]*[:\s]+([^\s\n]{4,})/i);
  const password = passwordMatch ? passwordMatch[1].replace(/[.,;]$/, '') : null;

  return { url, password };
}

async function generateIMUserEmail({ outreach, agentName, agentEmail, imUrl, imPassword, buyerProfile }) {
  const openai        = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const listingRef    = outreach.listing_id_text?.replace('langcliffe_', '') ?? '';
  const businessName  = outreach.business_name_text ?? 'a business opportunity';
  const companyOverview = getField(buyerProfile, 'company_overview_text') ?? '';

  const prompt = `You are ${agentName}, an AI acquisition advisor. Write a short, exciting update email to your client.

The Information Memorandum (IM) for a business they've been pursuing has just arrived.

Business: ${businessName} (Ref ${listingRef})
IM access link: ${imUrl}
IM password: ${imPassword ?? '(see dashboard)'}
Their acquisition focus: ${companyOverview || 'UK business acquisitions'}

The email should:
1. Open with the exciting news that the IM has arrived for ${businessName}
2. Remind them briefly of the journey so far (expressed interest, signed the NDA, now the IM is here)
3. Give them the link and password clearly so they can access it immediately
4. Encourage them to review it and come back with questions — you're here to help them evaluate it
5. Warm sign-off as their advisor

Under 200 words. Plain text only, no markdown. No subject line.
Sign off as: ${agentName} | ${agentEmail}`;

  const completion = await openai.chat.completions.create({
    model:       'gpt-4o-mini',
    messages:    [{ role: 'user', content: prompt }],
    temperature: 0.5,
  });

  return completion.choices[0].message.content.trim();
}

/**
 * Called when a Langcliffe email is detected as an IM delivery.
 * Stores the IM URL + password, notifies the user, no admin approval needed.
 */
export async function handleIMReceived({ outreach, inboundMessage, userId }) {
  const { url: imUrl, password: imPassword } = extractIMDetails(inboundMessage);

  if (!imUrl) {
    console.warn(`[langcliffe] detectIM triggered but no URL extracted from email — treating as regular reply`);
    return false; // signal caller to fall through to handleLangcliffeReply
  }

  const agent      = await getAgentForUser(userId);
  const agentName  = agent?.name_text ?? agent?.name ?? 'Your Agent';
  const agentEmail = agent?.email_text ?? 'agent@acquiro.ai';

  // Store IM details on the outreach record and update status
  await storeIMDetails(outreach._id, { imUrl, imPassword });
  console.log(`[langcliffe] IM received for outreach ${outreach._id} — url: ${imUrl}`);

  // Auto-send user notification email
  const profileRes  = await getBuyerInfo(userId);
  const profile     = profileRes?.results?.[0] ?? {};
  const userDetails = await getUserDetails(userId);
  const userEmail   = userDetails?.email ?? null;

  if (userEmail) {
    try {
      const emailBody = await generateIMUserEmail({
        outreach, agentName, agentEmail, imUrl, imPassword, buyerProfile: profile,
      });
      const testRecipient   = process.env.LANGCLIFFE_TEST_RECIPIENT;
      const notifyRecipient = testRecipient || userEmail;
      await sendViaSendGrid({
        from:     agentEmail,
        fromName: agentDisplayName(agent?.name_text ?? agent?.name ?? 'agent'),
        to:       notifyRecipient,
        subject:  `${agentName} — The IM for ${outreach.business_name_text ?? 'your opportunity'} has arrived`,
        body:     emailBody,
      });
      console.log(`[langcliffe] IM notification email sent to ${notifyRecipient}`);
    } catch (err) {
      console.error(`[langcliffe] Failed to send IM notification email: ${err.message}`);
    }
  }

  // Create dashboard notification
  try {
    const listingRef = outreach.listing_id_text?.replace('langcliffe_', '') ?? '';
    const passwordLine = imPassword ? `\nPassword: ${imPassword}` : '';
    await createUserNotification({
      userId,
      type:       'im_received',
      title:      `IM available — ${outreach.business_name_text ?? 'Acquisition opportunity'}`,
      body:       `The Information Memorandum for Ref ${listingRef} is ready to review.\n\nLink: ${imUrl}${passwordLine}`,
      outreachId: outreach._id,
    });
  } catch (err) {
    console.error(`[langcliffe] Failed to create IM UserNotification: ${err.message}`);
  }

  return true; // handled
}

export async function handleNDAReceived({ outreach, inboundMessage, pdfBuffer, pdfFilename, userId }) {
  const agent      = await getAgentForUser(userId);
  const agentName  = agent?.name_text ?? agent?.name ?? 'Your Agent';
  const agentEmail = agent?.email_text ?? 'agent@acquiro.ai';

  // Upload NDA PDF to Bubble
  const ndaFileUrl = await uploadFileToBubble(pdfBuffer, pdfFilename, 'application/pdf');

  // Detect replacement: if an NDA file is already stored on this outreach, this is a second send
  const isReplacement = !!outreach.nda_file_text;

  // Generate acknowledgment draft
  const ackDraft = await generateAcknowledgmentBody({
    outreach,
    agentName,
    agentEmail,
    isReplacement,
    replacementContext: isReplacement ? inboundMessage : '',
  });

  // Update outreach record
  await updateOutreachNDA({ outreachId: outreach._id, ndaFileUrl, replyBody: inboundMessage, ackDraft });
  console.log(`[langcliffe] NDA received for outreach ${outreach._id} — acknowledgment queued`);

  // Auto-send user notification email (no admin approval needed — going to user not broker)
  const profileRes  = await getBuyerInfo(userId);
  const profile     = profileRes?.results?.[0];
  const userDetails = await getUserDetails(userId);
  const userEmail   = userDetails?.email ?? null;
  const listingRef  = outreach.listing_id_text?.replace('langcliffe_', '') ?? '';

  if (userEmail) {
    try {
      const emailBody = await generateUserNDAEmail({
        outreach,
        inboundMessage,
        agentName,
        agentEmail,
        buyerProfile: profile ?? {},
      });

      const testRecipient = process.env.LANGCLIFFE_TEST_RECIPIENT;
      const notifyRecipient = testRecipient || userEmail;
      await sendViaSendGrid({
        from:     agentEmail,
        fromName: agentDisplayName(agentName.replace(' @ Acquiro', '')),
        to:       notifyRecipient,
        subject:  `${agentName} — An acquisition opportunity needs your attention`,
        body:     emailBody,
      });
      console.log(`[langcliffe] User notification email sent to ${notifyRecipient}${testRecipient ? ' (test override)' : ''}`);
    } catch (err) {
      console.error(`[langcliffe] Failed to send user notification email: ${err.message}`);
    }
  }

  // Create or update UserNotification record in Bubble for dashboard banner
  try {
    const existingNotification = await getExistingUserNotification(userId, outreach._id);

    if (existingNotification) {
      // Replacement NDA — update the existing notification rather than creating a duplicate
      const brokerNote = inboundMessage?.trim()
        ? `The broker's note: "${inboundMessage.trim().substring(0, 200)}${inboundMessage.trim().length > 200 ? '…' : ''}"`
        : 'The broker has sent a replacement file.';
      await updateUserNotification(existingNotification._id, {
        title: `Updated NDA — ${outreach.business_name_text ?? 'Acquisition opportunity'}`,
        body:  `A replacement NDA has been received for ${outreach.business_name_text ?? 'a business opportunity'} (Ref ${listingRef}). The previous file has been replaced. ${brokerNote} Please download, sign, and upload the updated file from your dashboard.`,
      });
      console.log(`[langcliffe] UserNotification ${existingNotification._id} updated with replacement NDA for user ${userId}`);
    } else {
      await createUserNotification({
        userId,
        type:       'nda_required',
        title:      `NDA required — ${outreach.business_name_text ?? 'Acquisition opportunity'}`,
        body:       `An NDA has been sent for ${outreach.business_name_text ?? 'a business opportunity'} (Ref ${listingRef}). Download, sign, and upload it from your dashboard to receive the full Information Memorandum.`,
        outreachId: outreach._id,
      });
      console.log(`[langcliffe] UserNotification record created for user ${userId}`);
    }
  } catch (err) {
    console.error(`[langcliffe] Failed to create/update UserNotification: ${err.message}`);
  }
}

/**
 * Send the acknowledgment email to Langcliffe. Admin-approved.
 */
export async function sendApprovedAcknowledgment(outreachId) {
  const outreach = await getLangcliffeOutreach(outreachId);
  if (!outreach) throw new Error(`LangcliffeOutreach record not found: ${outreachId}`);
  if (!outreach.acknowledgment_draft_text) throw new Error(`No acknowledgment draft on outreach: ${outreachId}`);

  const userId = outreach.user_user;
  const agent  = await getAgentForUser(userId);

  const rawName   = agent?.name_text ?? agent?.name ?? 'agent';
  const fromEmail = `${sanitiseAgentName(rawName)}@acquiro-agent.com`;
  const fromName  = agentDisplayName(rawName);

  const ref     = outreach.listing_id_text?.replace('langcliffe_', '') ?? '';
  const subject = `RE: Acquisition enquiry — Ref ${ref}: ${outreach.business_name_text ?? 'Business opportunity'}`;

  const testRecipient = process.env.LANGCLIFFE_TEST_RECIPIENT;
  const recipient     = testRecipient || outreach.langcliffe_contact_text;

  await sendViaSendGrid({
    from:      fromEmail,
    fromName,
    to:        recipient,
    subject,
    body:      outreach.acknowledgment_draft_text,
    inReplyTo: outreach.thread_message_id_text ?? null,
  });
  await approveAcknowledgment(outreachId);
  console.log(`[langcliffe] Acknowledgment sent for ${outreach.listing_id_text} → ${recipient}${testRecipient ? ' (test override)' : ''}`);
}

/**
 * Generate and queue an NDA return draft after user uploads signed NDA.
 */
export async function generateAndQueueNDAReturn(outreach) {
  const userId = outreach.user_user;
  const agent  = await getAgentForUser(userId);

  const agentName  = agent?.name_text ?? agent?.name ?? 'Your Agent';
  const agentEmail = agent?.email_text ?? 'agent@acquiro.ai';

  const ndaReturnDraft = await generateNDAReturnBody({ outreach, agentName, agentEmail });
  await updateNDAReturnDraft(outreach._id, ndaReturnDraft);
  console.log(`[langcliffe] NDA return draft generated for outreach ${outreach._id}`);
}

/**
 * Send the NDA return email with signed PDF attached. Admin-approved.
 */
export async function sendApprovedNDAReturn(outreachId) {
  const outreach = await getLangcliffeOutreach(outreachId);
  if (!outreach) throw new Error(`LangcliffeOutreach record not found: ${outreachId}`);
  if (!outreach.nda_return_draft_text) throw new Error(`No NDA return draft on outreach: ${outreachId}`);
  if (!outreach.signed_nda_file_text) throw new Error(`No signed NDA file on outreach: ${outreachId}`);

  const userId = outreach.user_user;
  const agent  = await getAgentForUser(userId);

  const rawName   = agent?.name_text ?? agent?.name ?? 'agent';
  const fromEmail = `${sanitiseAgentName(rawName)}@acquiro-agent.com`;
  const fromName  = agentDisplayName(rawName);

  const ref     = outreach.listing_id_text?.replace('langcliffe_', '') ?? '';
  const subject = `RE: Acquisition enquiry — Ref ${ref}: ${outreach.business_name_text ?? 'Business opportunity'}`;

  const testRecipient = process.env.LANGCLIFFE_TEST_RECIPIENT;
  const recipient     = testRecipient || outreach.langcliffe_contact_text;

  // Download signed NDA from Bubble and base64-encode it
  const fileRes = await fetch(outreach.signed_nda_file_text);
  if (!fileRes.ok) throw new Error(`Failed to download signed NDA: ${fileRes.status}`);
  const fileBuffer = Buffer.from(await fileRes.arrayBuffer());
  const base64File = fileBuffer.toString('base64');

  // Send via SendGrid with attachment
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) throw new Error('SENDGRID_API_KEY env var is not set');

  const ndaReturnPayload = {
    personalizations: [{ to: [{ email: recipient }] }],
    from:    { email: fromEmail, name: fromName },
    subject,
    content: [{ type: 'text/plain', value: outreach.nda_return_draft_text }],
    attachments: [{
      content:     base64File,
      filename:    'signed-nda.pdf',
      type:        'application/pdf',
      disposition: 'attachment',
    }],
  };
  if (outreach.thread_message_id_text) {
    ndaReturnPayload.headers = {
      'In-Reply-To': outreach.thread_message_id_text,
      'References':  outreach.thread_message_id_text,
    };
  }

  const sgRes = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(ndaReturnPayload),
  });

  if (!sgRes.ok) {
    const text = await sgRes.text();
    throw new Error(`SendGrid returned HTTP ${sgRes.status}: ${text}`);
  }

  await approveNDAReturn(outreachId);
  console.log(`[langcliffe] NDA return sent for ${outreach.listing_id_text} → ${recipient}${testRecipient ? ' (test override)' : ''}`);
}
