/**
 * Handles inbound user replies to agent-sent match digest emails.
 *
 * Pipeline:
 *   1. Look up thread → get userId
 *   2. Save inbound email record to Bubble
 *   3. Load thread history, agent personality, buyer criteria
 *   4. OpenAI classify intent (specific_listing | general | criteria_update)
 *   5. Generate contextual reply
 *   6. If criteria_update: extract + persist updated criteria
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
} from './bubbleClient.js';

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;

function log(msg) {
  console.log(`[UserReplyHandler] ${msg}`);
}

function sanitizeAgentEmail(agentName) {
  return agentName.toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function classifyIntent(openai, { emailText, threadHistory, agentName, buyerInfo }) {
  const historyText = threadHistory
    .map((m) => `[${m.is_agent ? agentName : 'User'}]: ${m.body}`)
    .join('\n\n');

  const prompt = `You are classifying a user's email reply to their AI M&A advisor.

Thread history:
${historyText}

Latest user reply:
${emailText}

Buyer profile summary:
${buyerInfo ? JSON.stringify(buyerInfo) : 'Not available'}

Classify the intent of the latest user reply as exactly one of:
- specific_listing — the user is asking about or referencing a specific business opportunity
- criteria_update — the user is updating or changing their acquisition search criteria (budget, sector, location, size, etc.)
- general — a general reply, question, or conversation not fitting the above

Reply with just the classification word, nothing else.`;

  const response = await openai.responses.create({
    model: 'gpt-4o-mini',
    input: prompt,
  });

  const raw = (response.output_text ?? '').trim().toLowerCase();
  if (raw.includes('specific_listing')) return 'specific_listing';
  if (raw.includes('criteria_update')) return 'criteria_update';
  return 'general';
}

async function identifyListingName(openai, { emailText, threadHistory, agentName }) {
  const historyText = threadHistory
    .map((m) => `[${m.is_agent ? agentName : 'User'}]: ${m.body}`)
    .join('\n\n');

  const prompt = `From this email thread, identify the exact name of the business the user is asking about.

Thread:
${historyText}

User's latest message:
${emailText}

Return only the business name as a plain string, nothing else. If you cannot identify a specific business, return an empty string.`;

  const response = await openai.responses.create({
    model: 'gpt-4o-mini',
    input: prompt,
  });

  return (response.output_text ?? '').trim().replace(/^["']|["']$/g, '');
}

function formatFullListing(business) {
  if (!business) return null;
  const fields = [
    `Name: ${business.business_name_text ?? 'Unknown'}`,
    `Sector: ${business.sector1_text ?? 'Unknown'}`,
    `Location: ${business.location_text ?? 'UK'}`,
    `Asking price: ${business.asking_price_text ?? business.asking_price_number ?? 'POA'}`,
    `Turnover: ${business.turnover_text ?? business.turnover_number ?? 'Not stated'}`,
    `EBITDA: ${business.ebitda_text ?? business.ebitda_number ?? 'Not stated'}`,
    `Established: ${business.established_text ?? 'Not stated'}`,
    `Employees: ${business.employees_text ?? business.employees_number ?? 'Not stated'}`,
    business.description_text ? `Description: ${business.description_text}` : null,
    business.more_info_text ? `Additional info: ${business.more_info_text}` : null,
    business.url_text ? `Listing URL: ${business.url_text}` : null,
  ];
  return fields.filter(Boolean).join('\n');
}

async function generateReply(openai, { intent, emailText, threadHistory, agentName, personality, style, traits, buyerInfo, fullListing }) {
  const historyText = threadHistory
    .map((m) => `[${m.is_agent ? agentName : 'User'}]: ${m.body}`)
    .join('\n\n');

  const buyerContext = buyerInfo
    ? `Buyer criteria: sector=${buyerInfo.sector_text ?? 'any'}, location=${buyerInfo.location_text ?? 'UK'}, budget=${buyerInfo.budget_text ?? 'flexible'}`
    : '';

  const personalityLine = personality ? `Your personality: ${personality}.` : '';
  const styleLine       = style       ? `Your style: ${style}.`             : '';
  const traitsLine      = traits      ? `Your traits: ${traits}.`           : '';

  let intentInstructions = '';
  if (intent === 'specific_listing') {
    if (fullListing) {
      intentInstructions = `The user is asking about a specific listing. Here are the full details:\n\n${fullListing}\n\nGive a thorough, helpful response — weave the key details into natural sentences rather than listing stats. Highlight what's most relevant to this buyer.`;
    } else {
      intentInstructions = 'The user is asking about a specific listing. Reference the relevant business from the thread and give helpful detail. If you cannot identify which one they mean, ask them to clarify.';
    }
  } else if (intent === 'criteria_update') {
    intentInstructions = 'The user has updated their buying criteria. Acknowledge what they have told you, confirm you have noted it, and let them know you will adjust their matches accordingly.';
  } else {
    intentInstructions = "Respond naturally to the user's message in the context of their acquisition journey.";
  }

  const prompt = `You are ${agentName}, an AI M&A advisor helping a user find and acquire a UK business. You are replying to their email.

${[personalityLine, styleLine, traitsLine].filter(Boolean).join(' ')}

${buyerContext}

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
- Return clean HTML using <p>, <ul>, <li>, <strong> tags only.
- Do not include a greeting or sign-off — those are added separately.`;

  const response = await openai.responses.create({
    model: 'gpt-4o-mini',
    input: prompt,
  });

  const body = response.output_text ?? '';
  return `<p>Hi,</p>\n${body}\n<p>${agentName}</p>`;
}

async function extractCriteriaUpdates(openai, emailText) {
  const prompt = `Extract updated buyer acquisition criteria from this email. Return a JSON object with only the fields that were explicitly mentioned or changed. Use these Bubble field names:

- sector_text (string) — business sector/industry
- location_text (string) — preferred location/region
- budget_text (string) — max budget or price range
- min_turnover_number (number) — minimum turnover in GBP
- max_turnover_number (number) — maximum turnover in GBP
- min_ebitda_number (number) — minimum EBITDA in GBP
- max_ebitda_number (number) — maximum EBITDA in GBP

Email:
${emailText}

Return only valid JSON with the fields that were explicitly updated. If nothing was clearly updated, return {}.`;

  const response = await openai.responses.create({
    model: 'gpt-4o-mini',
    input: prompt,
  });

  const raw = (response.output_text ?? '').trim();
  // Extract JSON from the response
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return {};
  try {
    return JSON.parse(match[0]);
  } catch {
    return {};
  }
}

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

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // 4. Classify intent
  const intent = await classifyIntent(openai, { emailText, threadHistory, agentName, buyerInfo });
  log(`Intent classified as: ${intent}`);

  // 5. If specific_listing, identify and fetch full business details
  let fullListing = null;
  if (intent === 'specific_listing') {
    try {
      const businessName = await identifyListingName(openai, { emailText, threadHistory, agentName });
      if (businessName) {
        const business = await getBusinessByName(businessName);
        fullListing = formatFullListing(business);
        log(`Fetched full listing for "${businessName}"`);
      }
    } catch (err) {
      log(`Failed to fetch full listing (non-fatal): ${err.message}`);
    }
  }

  // 5b. Generate reply
  const replyBody = await generateReply(openai, { intent, emailText, threadHistory, agentName, personality, style, traits, buyerInfo, fullListing });

  // 6. If criteria_update, extract and persist
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
        'References': `<${threadId}@acquiro-agent.com>`,
      },
    }),
  });

  if (!sgRes.ok) {
    const errText = await sgRes.text().catch(() => '');
    throw new Error(`SendGrid returned HTTP ${sgRes.status}: ${errText.substring(0, 200)}`);
  }

  log(`Reply sent to ${fromEmail} from ${toAgentEmail}`);

  // 8. Save agent reply to Bubble
  await createEmailRecord({ body: replyBody, threadId, userId });
  log(`Saved agent reply for user=${userId}`);
}
