/**
 * Daily email notification system.
 *
 * For each active subscriber:
 *   1. Fetch today's new matches (created in last 24h).
 *   2. If none, fall back to top 5 non-dismissed matches.
 *   3. Fetch business details for each match.
 *   4. Generate a personalised HTML email via OpenAI.
 *   5. Send via SendGrid directly.
 *   6. Write an Email record to Bubble.
 */

import { createHash } from 'crypto';
import OpenAI from 'openai';
import {
  getActiveSubscribers,
  getUserDetails,
  getAgentForUser,
  getBuyerInfo,
  getEmailThreadForUser,
  getTodaysMatchesForUser,
  getTopMatchesForUser,
  getBusinessById,
  createEmailRecord,
} from './bubbleClient.js';

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;

function sanitizeAgentEmail(agentName) {
  return agentName.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function log(msg) {
  console.log(`[EmailNotifier] ${msg}`);
}

function journeyContext(emailsSent) {
  if (emailsSent === 0) return `This is the first email you are sending ${'{userName}'}. Introduce yourself briefly — one line, nothing cheesy — and set the tone for how you work together.`;
  if (emailsSent <= 3)  return `You are early in the relationship with ${'{userName}'} — still building rapport. Be warm but not over-familiar yet.`;
  if (emailsSent <= 10) return `You have been working with ${'{userName}'} for a little while now. You know what they want and they know how you operate.`;
  return `You and ${'{userName}'} have a well-established working relationship. You know each other well. Keep it tight and comfortable — no need to over-explain anything.`;
}

// ── Business detail fetcher ────────────────────────────────────────────────────

async function fetchBusinessDetails(match) {
  const bubbleId = match.business_custom_business;
  if (!bubbleId) return null;
  try {
    return await getBusinessById(bubbleId);
  } catch (err) {
    log(`Could not fetch business ${bubbleId}: ${err.message}`);
    return null;
  }
}

// ── Email generation ───────────────────────────────────────────────────────────

function formatBusinessForPrompt(business) {
  if (!business) return null;
  const name        = business.business_name_text ?? business.title_text ?? 'Unknown Business';
  const price       = business.asking_price_text ?? (business.asking_price_number ? `£${business.asking_price_number.toLocaleString()}` : null) ?? 'POA';
  const sector      = business.sector1_text ?? null;
  const loc         = business.location_text ?? 'UK';
  const turnover    = business.turnover_text ?? (business.turnover_number ? `£${business.turnover_number.toLocaleString()}` : null);
  const ebitda      = business.net_profit_text ?? (business.net_profit_number ? `£${business.net_profit_number.toLocaleString()}` : null);
  const employees   = business.employees_text ?? (business.employees_number != null ? String(business.employees_number) : null);
  const established = business.established_text ?? null;
  const tenure      = business.tenure_text ?? null;
  const desc        = (business.description_text ?? '').slice(0, 500).trim();

  const stats = [
    sector      ? `Sector: ${sector}`       : null,
    `Location: ${loc}`,
    `Asking: ${price}`,
    turnover    ? `Turnover: ${turnover}`   : null,
    ebitda      ? `Net profit: ${ebitda}`   : null,
    employees   ? `Employees: ${employees}` : null,
    established ? `Est: ${established}`     : null,
    tenure      ? `Tenure: ${tenure}`       : null,
  ].filter(Boolean).join(' | ');

  const lines = [
    `Business: ${name}`,
    stats,
    desc ? `Description: ${desc}${desc.length === 500 ? '…' : ''}` : null,
  ];
  return lines.filter(Boolean).join('\n');
}

async function generateEmailBody({ agentName, userName, matches, isNewMatches, personality, style, traits, criteriaText, emailsSent }) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const matchesText = matches
    .map((m, i) => `${i + 1}. ${m}`)
    .join('\n\n');

  const personalityLine = personality ? `Your personality: ${personality}.` : '';
  const styleLine       = style       ? `Your style: ${style}.`             : '';
  const traitsLine      = traits      ? `Your traits: ${traits}.`           : '';
  const criteriaLine    = criteriaText ? `${userName}'s acquisition criteria: ${criteriaText}` : '';
  const relationshipLine = journeyContext(emailsSent).replace(/\$\{['"]?userName['"]?\}/g, userName);

  const context = isNewMatches
    ? `You have found ${matches.length} new acquisition opportunit${matches.length === 1 ? 'y' : 'ies'} for ${userName}.`
    : `Nothing new surfaced today that clears your bar. Be straight with ${userName} about that — don't dress it up. Then surface these deals from their existing pipeline as a reminder, briefly explaining why they're still worth a look:`;

  const matchInstructions = isNewMatches
    ? `- For each deal, give ${userName} enough detail to form a real opinion: what the business does, where it is, the key financials, and why it fits what they're after. Connect it to their specific criteria.`
    : `- For each deal, remind ${userName} why it was surfaced in the first place. A fresh angle, a stat they might not have focused on, or simply a "this one still stands out because..." — keep it brief but specific.`;

  const prompt = `You are ${agentName}, an AI M&A advisor. You are writing a personal daily email to ${userName}. You know ${userName} well — their goals, what gets them interested, and exactly what they're looking for.

${[personalityLine, styleLine, traitsLine].filter(Boolean).join(' ')}

${criteriaLine}

Relationship context: ${relationshipLine}

${context}

${matchesText}

Instructions:
- Write exactly as ${agentName} would speak — relaxed, direct, like you're messaging a mate who happens to be looking to buy a business. Not formal. Not corporate.
- Start with a natural greeting and a short opener (2-3 sentences max). Address ${userName} directly and casually — the greeting should match your personality (e.g. "Morning," / "Hey ${userName}," / just their name). Follow it with something personal: what you've been scanning, what the market looks like, or a quick nod to what ${userName} is after. Do NOT reference the date, and do NOT use "here's today's list" or anything that sounds like a newsletter intro.
${matchInstructions}
- Use the full data provided for each listing. Weave the numbers into natural sentences — no bullet-point stat dumps.
- Keep each deal to 2-3 sentences max — punchy, not a paragraph.
- Do not use phrases like "exciting opportunity", "I'm pleased to share", "I hope this finds you well", "don't miss out", or any marketing language.
- Do not sign off — added separately.
- Return clean HTML (no \`\`\`html wrapper). Use <p>, <ul>, <li>, <strong> tags only.`;

  const response = await openai.responses.create({
    model: 'gpt-4o-mini',
    input: prompt,
  });

  const body = response.output_text ?? response.output?.[0]?.content?.[0]?.text ?? '';
  const footer = `<p>Reply to this email if you want to discuss any of these, or if your criteria have changed.</p>\n<p>${agentName}</p>`;
  return `${body}\n${footer}`;
}

// ── Per-user pipeline ──────────────────────────────────────────────────────────

export async function sendEmailForUser(userId) {
  // 1. User details
  const user = await getUserDetails(userId);
  const email = user?.authentication?.email?.email ?? user?.email_text ?? null;
  if (!email) {
    log(`user=${userId} has no email address — skipping`);
    return { skipped: true, reason: 'no email' };
  }

  // 2. Agent details + user name + email history (for journey context)
  const [agent, buyerInfoRes, emailThread] = await Promise.all([
    getAgentForUser(userId),
    getBuyerInfo(userId).catch(() => null),
    getEmailThreadForUser(userId).catch(() => []),
  ]);
  const agentName   = agent?.name_text ?? agent?.agent_name_text ?? 'Your Acquiro Advisor';
  const userName    = user?.name_text ?? 'there';
  const personality = agent?.personality_options_option_personalityoptions ?? null;
  const style       = agent?.style_text ?? null;
  const traits      = agent?.traits_text ?? null;

  // Count only outbound agent digest emails (is_agent = true)
  const emailsSent = emailThread.filter((e) => e.is_agent).length;

  const buyerProfile = buyerInfoRes?.results?.[0] ?? null;
  const criteriaText = buyerProfile ? [
    buyerProfile.ebitda_range_text   ? `EBITDA: ${buyerProfile.ebitda_range_text}`     : null,
    buyerProfile.turnover_range_text ? `Turnover: ${buyerProfile.turnover_range_text}` : null,
    buyerProfile.initial_budget_text ? `Budget: ${buyerProfile.initial_budget_text}`   : null,
    buyerProfile.industry_preferences_list_option_sectors?.length
      ? `Sectors: ${buyerProfile.industry_preferences_list_option_sectors.join(', ')}` : null,
  ].filter(Boolean).join('; ') : '';

  // 3. Today's matches (cap at 5)
  let matchRecords = (await getTodaysMatchesForUser(userId)).slice(0, 5);
  let isNewMatches = matchRecords.length > 0;

  // 4. Fallback: top non-dismissed matches
  if (!isNewMatches) {
    matchRecords = await getTopMatchesForUser(userId, 3);
    if (matchRecords.length === 0) {
      log(`user=${userId} has no matches at all — skipping`);
      return { skipped: true, reason: 'no matches' };
    }
  }

  // 5. Fetch business details
  const businesses = await Promise.all(matchRecords.map((m) => fetchBusinessDetails(m)));

  const formattedMatches = matchRecords
    .map((m, i) => formatBusinessForPrompt(businesses[i]))
    .filter(Boolean);

  if (formattedMatches.length === 0) {
    log(`user=${userId} — could not format any business details — skipping`);
    return { skipped: true, reason: 'no business details' };
  }

  // 6. Generate email body
  const emailBody = await generateEmailBody({
    agentName, userName, matches: formattedMatches, isNewMatches,
    personality, style, traits, criteriaText, emailsSent,
  });

  // 7. Send via SendGrid
  const userHash = parseInt(createHash('sha256').update(userId).digest('hex').slice(0, 8), 16).toString(36);
  const day = Math.floor(Date.now() / 86400000).toString(36);
  const threadId = `${userHash}-${day}`;

  if (!SENDGRID_API_KEY) throw new Error('SENDGRID_API_KEY env var is not set');

  const sanitizedName = sanitizeAgentEmail(agentName);
  const fromAddress = `${sanitizedName}@acquiro-agent.com`;
  const matchCount = matchRecords.length;
  const subject = isNewMatches
    ? `${agentName}: ${matchCount} deal${matchCount > 1 ? 's' : ''} worth your attention | Ref:${threadId}`
    : `${agentName}: your pipeline this week | Ref:${threadId}`;

  const sgRes = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SENDGRID_API_KEY}`,
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email }] }],
      from: { email: fromAddress, name: agentName },
      reply_to: { email: fromAddress, name: agentName },
      subject,
      content: [{ type: 'text/html', value: emailBody }],
    }),
  });

  if (!sgRes.ok) {
    const errText = await sgRes.text().catch(() => '');
    throw new Error(`SendGrid returned HTTP ${sgRes.status}: ${errText.substring(0, 200)}`);
  }

  log(`Email sent via SendGrid for user=${userId} from=${fromAddress} (${isNewMatches ? matchRecords.length + ' new matches' : 'top matches reminder'}, email #${emailsSent + 1})`);

  // 8. Create Email record in Bubble
  await createEmailRecord({ body: emailBody, threadId, userId });

  return { sent: true, isNewMatches, matchCount: matchRecords.length };
}

// ── Full run across all subscribers ───────────────────────────────────────────

export async function runEmailNotifications() {
  log('Starting daily email notifications…');
  const userIds = await getActiveSubscribers();
  log(`${userIds.length} active subscriber(s) to notify`);

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const userId of userIds) {
    try {
      const result = await sendEmailForUser(userId);
      if (result.skipped) {
        log(`user=${userId} skipped: ${result.reason}`);
        skipped++;
      } else {
        sent++;
      }
    } catch (err) {
      log(`user=${userId} failed: ${err.message}`);
      failed++;
    }
  }

  log(`Done. Sent: ${sent} | Skipped: ${skipped} | Failed: ${failed}`);
  return { sent, skipped, failed };
}
