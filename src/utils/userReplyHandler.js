/**
 * Handles inbound user replies to agent-sent match digest emails.
 *
 * Pipeline:
 *   1. Look up thread → get userId
 *   2. Save inbound email record to Bubble
 *   3. Load thread history, agent personality, buyer criteria
 *   4. OpenAI classify intent (specific_listing | pursue | criteria_update | criteria_query | general)
 *   5. Generate contextual reply
 *   6. Side effects: create pursue request, persist criteria updates
 *   7. Send reply via SendGrid, save agent reply to Bubble
 */

import OpenAI from 'openai';
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
} from './bubbleClient.js';

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;

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
    buyerInfo.ebitda_range_text      ? `EBITDA target: ${buyerInfo.ebitda_range_text}`     : null,
    buyerInfo.turnover_range_text    ? `Turnover target: ${buyerInfo.turnover_range_text}` : null,
    buyerInfo.initial_budget_text    ? `Budget: ${buyerInfo.initial_budget_text}`           : null,
    buyerInfo.industry_preferences_list_option_sectors?.length
      ? `Preferred sectors: ${buyerInfo.industry_preferences_list_option_sectors.join(', ')}` : null,
    buyerInfo.geography_text         ? `Geography: ${buyerInfo.geography_text}`             : null,
  ].filter(Boolean).join(' | ');
}

// ── Intent classification ──────────────────────────────────────────────────────

async function classifyIntent(openai, { emailText, historyText, buyerContext }) {
  const prompt = `You are classifying a user's email reply to their AI M&A advisor.

Thread history:
${historyText}

Latest user reply:
${emailText}

Buyer profile: ${buyerContext || 'Not available'}

Classify the intent of the latest user reply as exactly one of:
- specific_listing — the user is asking for more detail or information about a specific business opportunity
- pursue — the user wants to move forward with a listing, express serious interest, or asks the advisor to contact the broker/seller
- criteria_update — the user is changing their search criteria (budget, sector, location, size, etc.)
- criteria_query — the user is asking what their current search criteria or preferences are
- general — a general reply, question, or conversation not fitting the above

Reply with just the classification word, nothing else.`;

  const response = await openai.responses.create({ model: 'gpt-4o-mini', input: prompt });
  const raw = (response.output_text ?? '').trim().toLowerCase();
  if (raw.includes('specific_listing')) return 'specific_listing';
  if (raw.includes('pursue'))           return 'pursue';
  if (raw.includes('criteria_update'))  return 'criteria_update';
  if (raw.includes('criteria_query'))   return 'criteria_query';
  return 'general';
}

// ── Business identification ────────────────────────────────────────────────────

async function identifyListingName(openai, { emailText, historyText }) {
  const prompt = `From this email thread, identify the exact name of the business the user is referring to.

Thread:
${historyText}

User's latest message:
${emailText}

Return only the business name as a plain string, nothing else. If you cannot identify a specific business, return an empty string.`;

  const response = await openai.responses.create({ model: 'gpt-4o-mini', input: prompt });
  return (response.output_text ?? '').trim().replace(/^["']|["']$/g, '');
}

function formatFullListing(business) {
  if (!business) return null;
  return [
    `Name: ${business.business_name_text ?? 'Unknown'}`,
    `Sector: ${business.sector1_text ?? 'Unknown'}`,
    `Location: ${business.location_text ?? 'UK'}`,
    `Asking price: ${business.asking_price_text ?? (business.asking_price_number ? `£${business.asking_price_number.toLocaleString()}` : 'POA')}`,
    `Turnover: ${business.turnover_text ?? (business.turnover_number ? `£${business.turnover_number.toLocaleString()}` : 'Not stated')}`,
    `Net profit: ${business.net_profit_text ?? (business.net_profit_number ? `£${business.net_profit_number.toLocaleString()}` : 'Not stated')}`,
    `Established: ${business.established_text ?? 'Not stated'}`,
    `Employees: ${business.employees_text ?? (business.employees_number != null ? String(business.employees_number) : 'Not stated')}`,
    business.description_text ? `Description: ${business.description_text}` : null,
    business.more_info_text   ? `Additional info: ${business.more_info_text}` : null,
    business.url_text         ? `Listing URL: ${business.url_text}` : null,
  ].filter(Boolean).join('\n');
}

// ── Reply generation ───────────────────────────────────────────────────────────

async function generateReply(openai, { intent, emailText, historyText, agentName, personality, style, traits, buyerContext, fullListing, buyerInfo }) {
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
    if (fullListing) {
      intentInstructions = `The user wants to move forward with a specific listing. Here are the full details:\n\n${fullListing}\n\nDo two things: (1) Share everything you know about this business — give them a thorough picture using the details above so they feel informed. (2) Let them know you are reaching out to the broker/seller on their behalf and will come back to them as soon as you hear something. Be specific about the business name. Do not give them the listing URL or tell them to contact the broker themselves — keep it on-platform.`;
    } else {
      intentInstructions = 'The user wants to pursue a listing but you could not identify which one. Ask them to clarify which business they mean.';
    }
  } else if (intent === 'criteria_update') {
    intentInstructions = 'The user has updated their search criteria. Acknowledge specifically what they have changed, confirm you have noted it, and let them know their next matches will reflect the update.';
  } else if (intent === 'criteria_query') {
    const criteriaReadback = buyerContext || 'No criteria on file yet.';
    intentInstructions = `The user is asking what their current search criteria are. Read back their criteria naturally: ${criteriaReadback}. If anything seems incomplete, note it and invite them to fill in the gaps.`;
  } else {
    intentInstructions = "Respond naturally to the user's message in the context of their acquisition journey.";
  }

  const prompt = `You are ${agentName}, an AI M&A advisor helping a user find and acquire a UK business. You are replying to their email.

${[personalityLine, styleLine, traitsLine].filter(Boolean).join(' ')}

${buyerContext ? `Buyer's acquisition criteria: ${buyerContext}` : ''}

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
  const prompt = `Extract updated buyer acquisition criteria from this email. Return a JSON object with only the fields explicitly mentioned or changed. Use these exact Bubble field names:

- ebitda_range_text (string) — EBITDA or profit target range, e.g. "£50k - £200k"
- turnover_range_text (string) — revenue/turnover range, e.g. "£500k - £2m"
- initial_budget_text (string) — available budget/deposit, e.g. "£300k"
- geography_text (string) — preferred location or region, e.g. "South East England"

Email:
${emailText}

Return only valid JSON with the fields explicitly updated. If nothing was clearly updated, return {}.`;

  const response = await openai.responses.create({ model: 'gpt-4o-mini', input: prompt });
  const raw = (response.output_text ?? '').trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return {};
  try {
    return JSON.parse(match[0]);
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

  // 3. Load thread history, agent, buyer info in parallel
  const [threadHistory, agent, buyerInfoRes] = await Promise.all([
    getEmailThreadForUser(userId),
    getAgentForUser(userId),
    getBuyerInfo(userId),
  ]);

  const agentName   = agent?.name_text ?? agent?.agent_name_text ?? 'Your Acquiro Advisor';
  const personality = agent?.personality_options_option_personalityoptions ?? null;
  const style       = agent?.style_text ?? null;
  const traits      = agent?.traits_text ?? null;
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
  if (intent === 'specific_listing' || intent === 'pursue') {
    try {
      const businessName = await identifyListingName(openai, { emailText, historyText });
      if (businessName) {
        business = await getBusinessByName(businessName);
        fullListing = formatFullListing(business);
        log(`Fetched full listing for "${businessName}"`);
      }
    } catch (err) {
      log(`Failed to fetch full listing (non-fatal): ${err.message}`);
    }
  }

  // 6a. If pursue: create a Pursue_Request record in Bubble
  if (intent === 'pursue' && business) {
    try {
      await createPursueRequest({
        userId,
        businessId: business._id,
        businessName: business.business_name_text ?? 'Unknown',
        listingUrl: business.url_text ?? '',
      });
      log(`Created pursue request for user=${userId} business=${business._id}`);
    } catch (err) {
      log(`Failed to create pursue request (non-fatal): ${err.message}`);
    }
  }

  // 6b. Generate reply
  const replyBody = await generateReply(openai, {
    intent, emailText, historyText, agentName,
    personality, style, traits, buyerContext, fullListing, buyerInfo,
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
