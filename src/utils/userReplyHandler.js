/**
 * Handles inbound user replies to agent-sent match digest emails.
 *
 * Pipeline:
 *   1. Look up thread → get userId
 *   2. Save inbound email record to Bubble
 *   3. Load thread history, agent personality, buyer criteria
 *   4. OpenAI classify intent (10 intents)
 *   5. Generate contextual reply with capability boundaries
 *   6. Side effects: create pursue request, persist criteria updates
 *   7. Send reply via SendGrid, save agent reply to Bubble
 */

import OpenAI from 'openai';
import { SECTOR_LABELS } from './sectorClassifier.js';
import {
  getEmailRecordByThreadId,
  saveInboundEmailRecord,
  getEmailThreadForUser,
  getAgentForUser,
  getBuyerInfo,
  createEmailRecord,
  updateBuyerCriteria,
  getBusinessByName,
  createPursueRequest,
  getUserPursueRequests,
} from './bubbleClient.js';

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;

// ── Phase 1: Capability boundaries ────────────────────────────────────────────

const CAPABILITY_BOUNDARIES = `
THINGS YOU CAN DO:
- Scan 25,000+ UK listings daily and match against their criteria
- Send daily match digests with new opportunities
- Discuss any listing in detail (financials, fit, red flags)
- Update their search criteria based on what they tell you
- Reach out to brokers on their behalf when they want to pursue a listing
- Help evaluate deals, discuss valuations, due diligence considerations
- Provide general M&A advisory (but not legal or tax advice)

THINGS YOU CANNOT DO — DO NOT PROMISE OR IMPLY THESE:
- Arrange viewings, phone calls, or in-person meetings with sellers/brokers
- Provide legal, tax, or accounting advice (recommend they consult a solicitor or accountant)
- Search for businesses on demand in real-time (matches are generated daily — explain criteria updates take effect on the next cycle)
- Access external data beyond what's in the listing (e.g. Companies House filings, detailed accounts)
- Make or manage subscription/billing changes (direct them to the Settings page in their dashboard)
- Remember previous voice calls in detail (you know their criteria from past conversations, but not word-for-word transcripts)

CRITICAL RULE: Never promise to do something not listed in your capabilities. If asked for something you can't do, acknowledge what you CAN do that's closest, and be upfront about the limitation. Be warm and helpful, not apologetic.
`.trim();

function log(msg) {
  console.log(`[UserReplyHandler] ${msg}`);
}

function sanitizeAgentEmail(agentName) {
  return agentName.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Strip HTML tags and collapse whitespace for clean AI input */
function stripHtml(html) {
  return (html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function formatThreadHistory(threadHistory, agentName) {
  return threadHistory
    .map((m) => `[${m.is_agent ? agentName : 'User'}]: ${stripHtml(m.body)}`)
    .join('\n\n');
}

function formatBuyerContext(buyerInfo) {
  if (!buyerInfo) return '';
  return [
    buyerInfo.ebitda_range            ? `EBITDA target: ${buyerInfo.ebitda_range}`           : null,
    buyerInfo.turnover_range          ? `Turnover target: ${buyerInfo.turnover_range}`       : null,
    buyerInfo.initial_budget          ? `Budget: ${buyerInfo.initial_budget}`                 : null,
    buyerInfo.industry_preferences?.length
      ? `Preferred sectors: ${buyerInfo.industry_preferences.join(', ')}` : null,
    buyerInfo.geography               ? `Geography: ${buyerInfo.geography}`                  : null,
  ].filter(Boolean).join(' | ');
}

function formatPursuitsForPrompt(pursuits) {
  if (!pursuits?.length) return null;
  return pursuits.map((p) => {
    const name = p.business_name || 'Unknown Business';
    const notes = p.admin_notes?.trim() || null;
    if (p.status === 'pending') {
      return `- ${name}: interest registered, waiting to hear back from the broker`;
    }
    if (p.status === 'contacted') {
      return `- ${name}: broker contacted, awaiting their response`;
    }
    if (p.status === 'responded') {
      return `- ${name}: broker has responded${notes ? ` — ${notes}` : ''}`;
    }
    return `- ${name}: status ${p.status ?? 'unknown'}`;
  }).filter(Boolean).join('\n');
}

// ── Phase 2: Intent classification (expanded to 10 intents) ──────────────────

async function classifyIntent(openai, { emailText, historyText, buyerContext }) {
  // For very short messages, skip thread history to prevent context bleeding
  const wordCount = emailText.trim().split(/\s+/).length;
  const includeHistory = wordCount > 8;

  const prompt = `You are classifying a user's email reply to their AI M&A advisor.
${includeHistory ? `
Thread history (for context only — classify based on the LATEST reply, not previous messages):
${historyText}
` : ''}
Latest user reply:
${emailText}

Buyer profile: ${buyerContext || 'Not available'}

Classify the intent of the latest user reply as exactly one of:
- specific_listing — the user is asking for more detail or information about a specific business opportunity
- pursue — the user wants to move forward with a listing, express serious interest, or asks the advisor to contact the broker/seller. Must contain an explicit request to pursue, move forward, or contact the broker — NOT just a brief reply like "yes" or "sounds good"
- criteria_update — the user is changing their search criteria (budget, sector, location, size, etc.)
- criteria_query — the user is asking what their current search criteria or preferences are
- pursue_status — the user is asking about the status of a listing they previously asked to pursue, or asking about their pipeline/progress generally (e.g. "what's happening with...", "any updates on...", "where are we at with...")
- deal_analysis — the user is asking for an opinion on a specific listing's valuation, financials, or fit (e.g. "what do you think of the numbers?", "is this a good deal?", "are the financials solid?")
- compare_listings — the user is comparing two or more specific businesses (e.g. "how does X compare to Y?", "which is better, X or Y?")
- advisory — the user is asking for general M&A advice, due diligence guidance, process questions, or negotiation strategy (e.g. "what should I look for?", "what questions should I ask?", "how does due diligence work?")
- account — the user is asking about their subscription, billing, cancellation, or account settings (e.g. "how do I cancel?", "I want to pause", "change my email")
- help — the user is asking what the advisor can do, how the platform works, or what services are available (e.g. "what can you do?", "how does this work?", "who are you?")
- general — a general reply, question, or conversation not fitting any of the above. Short acknowledgements like "thanks", "sounds good", "okay", "great", "cheers", "will do", "noted", "yes", "no" are ALWAYS general.

Reply with just the classification word, nothing else.`;

  const response = await openai.responses.create({ model: 'gpt-4o-mini', input: prompt });
  const raw = (response.output_text ?? '').trim().toLowerCase();
  if (raw.includes('specific_listing'))  return 'specific_listing';
  if (raw.includes('pursue_status'))     return 'pursue_status';
  if (raw.includes('pursue'))            return 'pursue';
  if (raw.includes('criteria_update'))   return 'criteria_update';
  if (raw.includes('criteria_query'))    return 'criteria_query';
  if (raw.includes('deal_analysis'))     return 'deal_analysis';
  if (raw.includes('compare_listings'))  return 'compare_listings';
  if (raw.includes('advisory'))          return 'advisory';
  if (raw.includes('account'))           return 'account';
  if (raw.includes('help'))              return 'help';
  return 'general';
}

// ── Business identification ────────────────────────────────────────────────────

/** Extract candidate business names from the thread by asking OpenAI to list them all */
async function extractCandidateNames(openai, historyText) {
  const prompt = `List every business name mentioned in this email thread. These are UK businesses for sale that were discussed between an M&A advisor and a buyer.

Thread:
${historyText}

Return a JSON array of exact business name strings as they appear in the thread. E.g. ["Acme Engineering Ltd", "Northern Pubs Group"]. If no businesses are mentioned, return [].`;

  const response = await openai.responses.create({ model: 'gpt-4o-mini', input: prompt });
  const raw = (response.output_text ?? '').trim();
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed.filter((n) => typeof n === 'string' && n.length > 0) : [];
  } catch {
    return [];
  }
}

async function identifyListingName(openai, { emailText, historyText, candidateNames }) {
  const candidateHint = candidateNames?.length
    ? `\n\nThese businesses have been mentioned in the thread:\n${candidateNames.map((n, i) => `${i + 1}. ${n}`).join('\n')}\n\nPick from this list if possible. Return the name EXACTLY as it appears in the list.`
    : '';

  const prompt = `From this email thread, identify the exact name of the business the user is referring to in their latest message.
${candidateHint}

Thread:
${historyText}

User's latest message:
${emailText}

Return only the business name as a plain string, nothing else. If you cannot identify a specific business, return an empty string.`;

  const response = await openai.responses.create({ model: 'gpt-4o-mini', input: prompt });
  return (response.output_text ?? '').trim().replace(/^["']|["']$/g, '');
}

async function identifyMultipleListingNames(openai, { emailText, historyText, candidateNames }) {
  const candidateHint = candidateNames?.length
    ? `\n\nThese businesses have been mentioned in the thread:\n${candidateNames.map((n, i) => `${i + 1}. ${n}`).join('\n')}\n\nPick from this list if possible. Return names EXACTLY as they appear in the list.`
    : '';

  const prompt = `From this email thread, identify ALL business names the user is referring to or comparing in their latest message.
${candidateHint}

Thread:
${historyText}

User's latest message:
${emailText}

Return a JSON array of business name strings, e.g. ["Business A", "Business B"]. If you cannot identify any specific businesses, return [].`;

  const response = await openai.responses.create({ model: 'gpt-4o-mini', input: prompt });
  const raw = (response.output_text ?? '').trim();
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed.filter((n) => typeof n === 'string' && n.length > 0) : [];
  } catch {
    return [];
  }
}

/** Search for a business by name with fallback — tries full name, then shorter fragments */
async function findBusinessByName(name) {
  if (!name) return null;

  // Try 1: full name (existing contains search)
  let result = await getBusinessByName(name);
  if (result) return result;
  log(`getBusinessByName("${name}") returned null — trying fallback`);

  // Try 2: strip common prefixes/suffixes and retry
  const cleaned = name.replace(/^(the|a)\s+/i, '').replace(/\s+(ltd|limited|plc|llp|inc)\.?$/i, '').trim();
  if (cleaned !== name && cleaned.length > 3) {
    result = await getBusinessByName(cleaned);
    if (result) { log(`Fallback matched on cleaned name: "${cleaned}"`); return result; }
  }

  // Try 3: use first 3 significant words (skip articles)
  const words = cleaned.split(/\s+/).filter((w) => w.length > 2);
  if (words.length > 2) {
    const shortName = words.slice(0, 3).join(' ');
    result = await getBusinessByName(shortName);
    if (result) { log(`Fallback matched on short name: "${shortName}"`); return result; }
  }

  // Try 4: first 2 words
  if (words.length > 1) {
    const twoWords = words.slice(0, 2).join(' ');
    result = await getBusinessByName(twoWords);
    if (result) { log(`Fallback matched on two words: "${twoWords}"`); return result; }
  }

  log(`All fallback searches failed for "${name}"`);
  return null;
}

function formatFullListing(business) {
  if (!business) return null;
  return [
    `Name: ${business.business_name ?? 'Unknown'}`,
    `Sector: ${business.sector ?? 'Unknown'}`,
    `Location: ${business.location ?? 'UK'}`,
    `Asking price: ${business.asking_price ? `£${business.asking_price.toLocaleString()}` : 'POA'}`,
    `Turnover: ${business.turnover ? `£${business.turnover.toLocaleString()}` : 'Not stated'}`,
    `Net profit: ${business.net_profit ? `£${business.net_profit.toLocaleString()}` : 'Not stated'}`,
    `Established: ${business.established ?? 'Not stated'}`,
    `Employees: ${business.employees != null ? String(business.employees) : 'Not stated'}`,
    business.description ? `Description: ${business.description}` : null,
    business.more_info   ? `Additional info: ${business.more_info}` : null,
    business.url         ? `Listing URL: ${business.url}` : null,
  ].filter(Boolean).join('\n');
}

// ── Reply generation ───────────────────────────────────────────────────────────

async function generateReply(openai, { intent, emailText, historyText, agentName, personality, style, traits, buyerContext, fullListing, buyerInfo, alreadyPursuing, activePursuits, comparisonListings }) {
  const personalityLine = personality ? `Your personality: ${personality}.` : '';
  const styleLine       = style       ? `Your style: ${style}.`             : '';
  const traitsLine      = traits      ? `Your traits: ${traits}.`           : '';

  let intentInstructions = '';

  if (intent === 'specific_listing') {
    if (fullListing) {
      intentInstructions = `The user is asking about a specific listing. Here are the full details:\n\n${fullListing}\n\nGive a thorough, helpful response — weave the key details into natural sentences rather than listing stats. Highlight what's most relevant to this buyer given their criteria.`;
    } else {
      intentInstructions = 'The user is asking about a specific listing. Reference the relevant business from the thread and give helpful detail. If you cannot identify which one they mean, ask them to clarify.';
    }
  } else if (intent === 'pursue') {
    if (fullListing && alreadyPursuing) {
      intentInstructions = `The user wants to move forward with a specific listing, but you are already chasing this one on their behalf. Here are the full details:\n\n${fullListing}\n\nAcknowledge that you already have this one in hand — let them know you are already in contact with the broker and will update them as soon as you hear back. Be reassuring but brief. Do not say you are reaching out again as if for the first time.`;
    } else if (fullListing) {
      intentInstructions = `The user wants to move forward with a specific listing. Here are the full details:\n\n${fullListing}\n\nDo two things: (1) Share everything you know about this business — give them a thorough picture using the details above so they feel informed. (2) Let them know you are reaching out to the broker/seller on their behalf and will come back to them as soon as you hear something. Be specific about the business name. Do not give them the listing URL or tell them to contact the broker themselves — keep it on-platform.`;
    } else {
      intentInstructions = 'The user wants to pursue a listing but you could not identify which one. Ask them to clarify which business they mean.';
    }
  } else if (intent === 'criteria_update') {
    intentInstructions = 'The user has updated their search criteria. Acknowledge specifically what they have changed, confirm you have noted it, and let them know their next matches will reflect the update. Be clear that matches are generated daily — they will see the change reflected in their next digest, not immediately.';
  } else if (intent === 'criteria_query') {
    const criteriaReadback = buyerContext || 'No criteria on file yet.';
    intentInstructions = `The user is asking what their current search criteria are. Read back their criteria naturally: ${criteriaReadback}. If anything seems incomplete, note it and invite them to fill in the gaps.`;

  // ── Phase 3: New intent handlers ──────────────────────────────────────────

  } else if (intent === 'pursue_status') {
    const pursuitsText = formatPursuitsForPrompt(activePursuits);
    if (pursuitsText) {
      intentInstructions = `The user is asking about the status of listings they are pursuing. Here are their active pursue requests:\n\n${pursuitsText}\n\nReport back naturally on each one. If status is 'pending', say you have registered their interest and are working on it. If 'contacted', say you have reached out to the broker and are waiting to hear back. If 'responded', share any updates or notes. Be honest — if there is no update yet, say so plainly. Do not invent progress.`;
    } else {
      intentInstructions = "The user is asking about pursue status, but they don't have any active pursue requests on file. Let them know — and remind them they can reply to any match email saying they want to pursue a listing, and you will reach out to the broker on their behalf.";
    }
  } else if (intent === 'deal_analysis') {
    if (fullListing) {
      intentInstructions = `The user is asking for your opinion on a deal. Here are the full details:\n\n${fullListing}\n\nAnalyse this deal. Comment on: (1) the price-to-profit multiple and whether it is reasonable for the sector, (2) how it fits the buyer's criteria, (3) any obvious flags (e.g. no profit stated, price vs turnover ratio, missing data). Be honest — if data is limited, say so. Do not invent numbers. If the multiple seems high or low, say so directly. End by noting they should consult a solicitor or accountant before making any financial commitments.`;
    } else {
      intentInstructions = 'The user is asking for a deal analysis but you could not identify which listing they mean. Ask them to clarify which business they would like you to evaluate.';
    }
  } else if (intent === 'compare_listings') {
    if (comparisonListings && comparisonListings.length >= 2) {
      const formatted = comparisonListings.map((l) => formatFullListing(l)).filter(Boolean).join('\n\n---\n\n');
      intentInstructions = `The user wants to compare these businesses side by side:\n\n${formatted}\n\nCompare them on: price, profitability (margins and multiples), sector, location, and alignment with the buyer's criteria. Be specific with numbers. Give an honest opinion on which looks stronger and why — but note any gaps in data. If one clearly fits the buyer's criteria better, say so directly.`;
    } else if (comparisonListings && comparisonListings.length === 1) {
      const formatted = formatFullListing(comparisonListings[0]);
      intentInstructions = `The user wanted to compare listings but you could only find one: \n\n${formatted}\n\nLet them know you could only identify one of the businesses they mentioned. Share what you know about this one and ask them to clarify the name of the other business they want to compare it with.`;
    } else {
      intentInstructions = 'The user wants to compare listings but you could not identify which businesses they mean. Ask them to name the specific businesses they would like compared.';
    }
  } else if (intent === 'advisory') {
    const listingContext = fullListing ? `\n\nThe user may be referring to this listing:\n${fullListing}` : '';
    intentInstructions = `The user is asking for M&A advice or guidance.${listingContext}\n\nProvide practical M&A advice relevant to this buyer's situation. You understand UK acquisition processes including asset vs share purchases, SPA negotiations, HMRC considerations, EIS/SEIS relief, earn-outs, and common deal structures. If the question is about a specific listing, reference its details. If it is general, tailor to their criteria and experience level. Always flag when they should consult a solicitor or accountant — frame it as "this is where a solicitor would add real value" rather than a disclaimer.`;
  } else if (intent === 'account') {
    intentInstructions = "The user has a question about their account, subscription, or billing. Direct them warmly to the Settings page in their dashboard where they can manage their subscription. Do not attempt to make account changes via email. If they seem unhappy, acknowledge it and invite them to share what's not working — but still point them to Settings for the actual change. The dashboard URL is their normal login page.";
  } else if (intent === 'help') {
    intentInstructions = "The user wants to know what you can do or how the platform works. Explain naturally: you scan the UK market daily across thousands of listings, match opportunities to their criteria, and send them a daily digest email. They can reply to any email to ask questions, update their search criteria, request more detail on a listing, or express interest — and you will reach out to the broker on their behalf. They also have a dashboard where they can browse matches and call you by voice. Be conversational, not a feature list. Keep it to 3-4 short paragraphs.";
  } else {
    intentInstructions = "Respond naturally to the user's message in the context of their acquisition journey.";
  }

  const prompt = `You are ${agentName}, an AI M&A advisor helping a user find and acquire a UK business. You are replying to their email.

${[personalityLine, styleLine, traitsLine].filter(Boolean).join(' ')}

${buyerContext ? `Buyer's acquisition criteria: ${buyerContext}` : ''}

${CAPABILITY_BOUNDARIES}

Email thread so far:
${historyText}

User's latest reply:
${emailText}

Task: ${intentInstructions}

Instructions:
- Write exactly as ${agentName} would speak — stay in character throughout. This should feel like a reply from a real person, not a platform.
- Be conversational and direct. No marketing language, no filler phrases like "Great question!" or "I hope this helps".
- Be concise — 2-4 short paragraphs.
- Do not use phrases like "I'm an AI" or reference the platform by name.
- Start with a natural, in-character greeting that fits your personality — not just "Hi,".
- Do not add a sign-off — added separately.
- Return clean HTML (no \`\`\`html wrapper). Use <p>, <ul>, <li>, <strong> tags only.`;

  const response = await openai.responses.create({ model: 'gpt-4o-mini', input: prompt });
  const body = response.output_text ?? '';
  return `${body}\n<p>${agentName}</p>`;
}

// ── Criteria extraction ────────────────────────────────────────────────────────

async function extractCriteriaUpdates(openai, emailText) {
  const prompt = `Extract updated buyer acquisition criteria from this email. Return a JSON object with only the fields explicitly mentioned or changed. Use these exact field names:

- ebitda_range (string) — EBITDA or profit target range, e.g. "£50k - £200k"
- turnover_range (string) — revenue/turnover range, e.g. "£500k - £2m"
- initial_budget (string) — available budget/deposit, e.g. "£300k"
- geography (string) — preferred location or region, e.g. "South East England"
- industry_preferences (array of strings) — sector preferences. Only include if the user explicitly mentions sectors or industries. You MUST pick from this exact list only:
${SECTOR_LABELS.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}
  Return the exact label text. Do not invent or paraphrase sector names.

Email:
${emailText}

Return only valid JSON with the fields explicitly updated. If nothing was clearly updated, return {}.`;

  const response = await openai.responses.create({ model: 'gpt-4o-mini', input: prompt });
  const raw = (response.output_text ?? '').trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return {};
  try {
    const parsed = JSON.parse(match[0]);
    // Guard: ensure any extracted sectors are valid canonical labels
    if (Array.isArray(parsed.industry_preferences)) {
      parsed.industry_preferences =
        parsed.industry_preferences.filter((s) => SECTOR_LABELS.includes(s));
      if (parsed.industry_preferences.length === 0) {
        delete parsed.industry_preferences;
      }
    }
    return parsed;
  } catch {
    return {};
  }
}

// ── Main handler ───────────────────────────────────────────────────────────────

export async function handleUserReply({ threadId, fromEmail, emailText, toAgentEmail, subject }) {
  log(`Processing reply from ${fromEmail} for threadId=${threadId}`);

  // 1. Look up thread record → userId
  const emailRecord = await getEmailRecordByThreadId(threadId);
  if (!emailRecord) {
    log(`No email record found for threadId=${threadId} — ignoring`);
    return;
  }
  const { userId } = emailRecord;

  // 2. Save inbound email to Bubble
  await saveInboundEmailRecord({ body: emailText, threadId, userId });
  log(`Saved inbound email for user=${userId}`);

  // 3. Load thread history, agent, buyer info, active pursuits in parallel
  const [threadHistory, agent, buyerInfoRes, activePursuits] = await Promise.all([
    getEmailThreadForUser(userId),
    getAgentForUser(userId),
    getBuyerInfo(userId),
    getUserPursueRequests(userId).catch(() => []),
  ]);

  const agentName   = agent?.name ?? 'Your Acquiro Advisor';
  const personality = agent?.personality ?? null;
  const style       = agent?.challenge_style ?? null;
  const traits      = agent?.traits ?? null;
  const buyerInfo   = buyerInfoRes?.results?.[0] ?? null;
  const buyerContext = formatBuyerContext(buyerInfo);
  const historyText  = formatThreadHistory(threadHistory, agentName);

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // 4. Classify intent
  const intent = await classifyIntent(openai, { emailText, historyText, buyerContext });
  log(`Intent classified as: ${intent}`);

  // 5. If listing-related, identify and fetch business details
  let fullListing = null;
  let business    = null;
  let comparisonListings = null;

  const listingIntents = ['specific_listing', 'pursue', 'deal_analysis', 'advisory'];
  const needsListing = listingIntents.includes(intent) || intent === 'compare_listings';

  // Extract candidate business names from thread once (shared by all listing lookups)
  let candidateNames = [];
  if (needsListing) {
    try {
      candidateNames = await extractCandidateNames(openai, historyText);
      log(`Candidate business names from thread: ${JSON.stringify(candidateNames)}`);
    } catch (err) {
      log(`Failed to extract candidate names (non-fatal): ${err.message}`);
    }
  }

  if (listingIntents.includes(intent)) {
    try {
      const businessName = await identifyListingName(openai, { emailText, historyText, candidateNames });
      log(`identifyListingName returned: "${businessName}"`);
      if (businessName) {
        business = await findBusinessByName(businessName);
        fullListing = formatFullListing(business);
        if (business) log(`Fetched full listing for "${businessName}"`);
        else log(`No listing found for "${businessName}" after all fallbacks`);
      }
    } catch (err) {
      log(`Failed to fetch full listing (non-fatal): ${err.message}`);
    }
  }

  // 5b. For compare_listings: identify and fetch multiple businesses
  if (intent === 'compare_listings') {
    try {
      const names = await identifyMultipleListingNames(openai, { emailText, historyText, candidateNames });
      log(`identifyMultipleListingNames returned: ${JSON.stringify(names)}`);
      if (names.length > 0) {
        const results = await Promise.all(names.map((n) => findBusinessByName(n).catch(() => null)));
        comparisonListings = results.filter(Boolean);
        log(`Fetched ${comparisonListings.length} listings for comparison`);
      }
    } catch (err) {
      log(`Failed to fetch comparison listings (non-fatal): ${err.message}`);
    }
  }

  // 6a. If pursue: create a Pursue_Request record in Bubble (guard against duplicates)
  let alreadyPursuing = false;
  if (intent === 'pursue' && business) {
    try {
      alreadyPursuing = activePursuits.some((p) => p.business_id === business.id);
      if (!alreadyPursuing) {
        await createPursueRequest({
          userId,
          businessId: business.id,
          businessName: business.business_name ?? 'Unknown',
          listingUrl: business.url ?? '',
        });
        log(`Created pursue request for user=${userId} business=${business.id}`);
      } else {
        log(`Pursue request already exists for user=${userId} business=${business.id} — skipping creation`);
      }
    } catch (err) {
      log(`Failed to handle pursue request (non-fatal): ${err.message}`);
    }
  }

  // 6b. Generate reply
  const replyBody = await generateReply(openai, {
    intent, emailText, historyText, agentName,
    personality, style, traits, buyerContext, fullListing, buyerInfo,
    alreadyPursuing, activePursuits, comparisonListings,
  });

  // 6c. If criteria_update: extract and persist
  if (intent === 'criteria_update') {
    try {
      const updates = await extractCriteriaUpdates(openai, emailText);
      if (Object.keys(updates).length > 0) {
        await updateBuyerCriteria(userId, updates);
        log(`Updated buyer criteria for user=${userId}: ${JSON.stringify(updates)}`);
      }
    } catch (err) {
      log(`Failed to update buyer criteria: ${err.message}`);
    }
  }

  // 7. Send reply via SendGrid
  if (!SENDGRID_API_KEY) throw new Error('SENDGRID_API_KEY env var is not set');

  const replySubject = subject.startsWith('Re:') ? subject : `Re: ${subject}`;

  const sgRes = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SENDGRID_API_KEY}`,
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: fromEmail }] }],
      from: { email: toAgentEmail, name: agentName },
      reply_to: { email: toAgentEmail, name: agentName },
      subject: replySubject,
      content: [{ type: 'text/html', value: replyBody }],
      headers: {
        'In-Reply-To': `<${threadId}@acquiro-agent.com>`,
        'References':  `<${threadId}@acquiro-agent.com>`,
      },
    }),
  });

  if (!sgRes.ok) {
    const errText = await sgRes.text().catch(() => '');
    throw new Error(`SendGrid returned HTTP ${sgRes.status}: ${errText.substring(0, 200)}`);
  }

  log(`Reply sent to ${fromEmail} from ${toAgentEmail} (intent=${intent})`);

  // 8. Save agent reply to Bubble
  await createEmailRecord({ body: replyBody, threadId, userId });
  log(`Saved agent reply for user=${userId}`);
}
