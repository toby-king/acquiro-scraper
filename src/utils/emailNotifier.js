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
  getUserPursueRequests,
  getTodaysMatchesForUser,
  getTopMatchesForUser,
  getBusinessById,
  createEmailRecord,
  getActiveFeatureAnnouncements,
  getUserFeatureImpressions,
  incrementFeatureImpression,
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
  const desc        = (business.description_text ?? '').slice(0, 800).trim();

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
    desc ? `Description: ${desc}${desc.length === 800 ? '…' : ''}` : null,
  ];
  return lines.filter(Boolean).join('\n');
}

function formatPursuitsForPrompt(pursuits) {
  if (!pursuits.length) return null;
  return pursuits.map((p) => {
    const name = p.business_name_text || 'Unknown Business';
    const notes = p.admin_notes_text?.trim() || null;
    if (p.status_text === 'pending') {
      return `- ${name}: interest registered, waiting to hear back from the broker`;
    }
    if (p.status_text === 'contacted') {
      return `- ${name}: broker contacted, awaiting their response`;
    }
    if (p.status_text === 'responded') {
      return `- ${name}: broker has responded${notes ? ` — ${notes}` : ''}`;
    }
    return null;
  }).filter(Boolean).join('\n');
}

async function generateEmailBody({ agentName, userName, matches, isNewMatches, personality, style, traits, criteriaText, emailsSent, activePursuits, featureAnnouncements, recentEmailHistory }) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const matchesText = matches
    .map((m, i) => `${i + 1}. ${m}`)
    .join('\n\n');

  const personalityLine  = personality  ? `Your personality: ${personality}.` : '';
  const styleLine        = style        ? `Your style: ${style}.`             : '';
  const traitsLine       = traits       ? `Your traits: ${traits}.`           : '';
  const criteriaLine     = criteriaText ? `${userName}'s acquisition criteria: ${criteriaText}` : '';
  const relationshipLine = journeyContext(emailsSent).replace(/\$\{['"]?userName['"]?\}/g, userName);
  const pursuitsText     = formatPursuitsForPrompt(activePursuits);

  const featureText = featureAnnouncements?.length
    ? featureAnnouncements.map((a) => `- ${a.headline_text}${a.cta_text ? ` (${a.cta_text})` : ''}`).join('\n')
    : null;

  const hasMatches = matches.length > 0;

  // Build recent email history summary for context (last 3 exchanges)
  const historyText = recentEmailHistory?.length
    ? recentEmailHistory.slice(-6).map((e) => `${e.is_agent ? agentName : userName}: ${e.body.slice(0, 300).replace(/<[^>]+>/g, '').trim()}`).join('\n')
    : null;

  const context = hasMatches
    ? (isNewMatches
        ? `You have found ${matches.length} new acquisition opportunit${matches.length === 1 ? 'y' : 'ies'} for ${userName}.`
        : `Nothing new surfaced today that clears your bar. Be straight with ${userName} about that — don't dress it up. Then surface these deals from their existing pipeline as a reminder, briefly explaining why they're still worth a look:`)
    : `Nothing new surfaced today on the deal front. Instead of listing deals, pick ONE of the following to write about — choose whichever feels most natural given your recent conversations:
  (a) Ask how their search is going — are they still focused on the same criteria, or has anything shifted?
  (b) Share a brief, genuine insight about the current market in their target sector (manufacturing, etc.)
  (c) Ask a specific question that would help you find better matches — e.g. geography flexibility, deal structure, minimum employee count
  Keep it short (3-5 sentences total after the greeting). This should feel like a quick check-in, not filler.`;

  const matchInstructions = hasMatches
    ? (isNewMatches
        ? `- For each deal, give ${userName} enough detail to form a real opinion: what the business does, where it is, the key financials, and why it fits what they're after. Connect it to their specific criteria.`
        : `- For each deal, remind ${userName} why it was surfaced in the first place. A fresh angle, a stat they might not have focused on, or simply a "this one still stands out because..." — keep it brief but specific.`)
    : '';

  const prompt = `You are ${agentName}, an AI M&A advisor. You are writing a personal daily email to ${userName}. You know ${userName} well — their goals, what gets them interested, and exactly what they're looking for.

${[personalityLine, styleLine, traitsLine].filter(Boolean).join(' ')}

${criteriaLine}

Relationship context: ${relationshipLine}

${pursuitsText ? `PURSUE REQUEST UPDATES (deals ${userName} has asked you to chase up):
${pursuitsText}` : ''}

${historyText ? `RECENT EMAIL HISTORY (for context — do NOT repeat or reference these directly, just use them to inform your tone and what to talk about):
${historyText}` : ''}

${context}

${hasMatches ? matchesText : ''}

Instructions:
- Write exactly as ${agentName} would speak — relaxed, direct, like you're messaging a mate who happens to be looking to buy a business. Not formal. Not corporate.
- Start with a natural greeting and a short opener (2-3 sentences max). Address ${userName} directly and casually — the greeting should match your personality (e.g. "Morning," / "Hey ${userName}," / just their name). Follow it with something personal: what you've been scanning, what the market looks like, or a quick nod to what ${userName} is after. Do NOT reference the date, and do NOT use "here's today's list" or anything that sounds like a newsletter intro.
${pursuitsText ? `- After the opener, give a brief natural update on each pursue request — one sentence each. Something like "Still chasing the broker on [name], no word yet" or "I've reached out to [name], waiting to hear back." Casual, not a status report. Then transition naturally into the deals below.` : ''}
${featureText ? `- After the opener and before any pursue updates, add a separate sentence framed as a quick update. Start with a short intro like "<strong>Quick update</strong> —" or "<strong>By the way</strong> —" in bold, then one sentence describing what's new and how to use it. Don't call it a "new feature" or make it sound like a product announcement. Here's what to mention:
${featureText}` : ''}
${hasMatches ? `- Before listing the deals, add one short transitional sentence that introduces them naturally — e.g. "In the meantime, a few from your pipeline worth keeping on your radar:" or similar. Make it feel like a natural handoff, not a heading.
- Each deal must be formatted as a clearly separated block:
  1. Business name in <strong> tags as a title on its own line
  2. Key stats (asking price, turnover, net profit, location, sector) as a short <ul> list — one stat per <li>. Omit any stat you don't have data for.
  3. A 1-2 sentence paragraph below explaining why this deal fits ${userName}'s criteria. Do not run deals together — each one must be its own block.` : ''}
${matchInstructions}
- Use the full data provided for each listing. Put the raw numbers in the stat list, then use the explanatory sentence(s) to connect it to ${userName}'s goals.
- Do not use phrases like "exciting opportunity", "I'm pleased to share", "I hope this finds you well", "don't miss out", or any marketing language.
- End with a short natural sign-off in character — one sentence that invites a reply, then your name on a new line. Match your personality. Not "Best regards", not "Kind regards", not "Don't hesitate to reach out". Make it clear they can reply directly to this email to chat — e.g. "Just hit reply if any of these catch your eye" or "Reply and let me know what you think". Keep it natural, not instructional.
- Return clean HTML (no \`\`\`html wrapper). Use <p>, <ul>, <li>, <strong> tags only.`;

  const response = await openai.responses.create({
    model: 'gpt-4o-mini',
    input: prompt,
  });

  const body = response.output_text ?? response.output?.[0]?.content?.[0]?.text ?? '';
  return body;
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

  // 2. Agent details + user name + email history + active pursue requests
  const [agent, buyerInfoRes, emailThread, activePursuits] = await Promise.all([
    getAgentForUser(userId),
    getBuyerInfo(userId).catch(() => null),
    getEmailThreadForUser(userId).catch(() => []),
    getUserPursueRequests(userId).catch(() => []),
  ]);

  const [announcements, impressions] = await Promise.all([
    getActiveFeatureAnnouncements().catch(() => []),
    getUserFeatureImpressions(userId).catch(() => []),
  ]);

  const impressionMap = new Map(
    impressions.map((imp) => [imp.feature_custom_featureannouncement, imp])
  );

  const qualifyingAnnouncements = announcements.filter((ann) => {
    // Skip if user has already completed this feature
    if (ann.completion_field_text && user[ann.completion_field_text]) return false;
    // Skip if user has already seen it max times
    const imp = impressionMap.get(ann._id);
    const seenCount = imp?.impressions_number ?? 0;
    if (seenCount >= (ann.max_impressions_number ?? 3)) return false;
    return true;
  });

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
  }

  // 5. Fetch business details, filtering out any already tracked as pursue requests
  const pursueBusinessIds = new Set(activePursuits.map((p) => p.business_custom_business).filter(Boolean));
  const filteredMatchRecords = matchRecords.filter((m) => !pursueBusinessIds.has(m.business_custom_business));

  const businesses = await Promise.all(filteredMatchRecords.map((m) => fetchBusinessDetails(m)));

  const formattedMatches = filteredMatchRecords
    .map((m, i) => formatBusinessForPrompt(businesses[i]))
    .filter(Boolean);

  // Skip only if there's genuinely nothing to say
  if (formattedMatches.length === 0 && activePursuits.length === 0 && qualifyingAnnouncements.length === 0) {
    log(`user=${userId} has no matches, no active pursuits, and no feature announcements — skipping`);
    return { skipped: true, reason: 'no content' };
  }

  // 6. Generate email body
  const emailBody = await generateEmailBody({
    agentName, userName, matches: formattedMatches, isNewMatches,
    personality, style, traits, criteriaText, emailsSent, activePursuits,
    featureAnnouncements: qualifyingAnnouncements,
    recentEmailHistory: emailThread,
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
    ? `${matchCount} new acquisition opportunit${matchCount > 1 ? 'ies' : 'y'} | Ref:${threadId}`
    : `Your pipeline update | Ref:${threadId}`;

  const sgRes = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SENDGRID_API_KEY}`,
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email }] }],
      from: { email: fromAddress, name: `${agentName} @ Acquiro` },
      reply_to: { email: fromAddress, name: `${agentName} @ Acquiro` },
      subject,
      content: [{ type: 'text/html', value: emailBody }],
      headers: {
        'Message-ID': `<${threadId}@acquiro-agent.com>`,
      },
    }),
  });

  if (!sgRes.ok) {
    const errText = await sgRes.text().catch(() => '');
    throw new Error(`SendGrid returned HTTP ${sgRes.status}: ${errText.substring(0, 200)}`);
  }

  log(`Email sent via SendGrid for user=${userId} from=${fromAddress} (${isNewMatches ? matchRecords.length + ' new matches' : 'top matches reminder'}, email #${emailsSent + 1})`);

  // Increment feature announcement impressions
  if (qualifyingAnnouncements.length > 0) {
    await Promise.all(
      qualifyingAnnouncements.map((ann) =>
        incrementFeatureImpression(userId, ann._id).catch((err) =>
          log(`Failed to increment impression for feature ${ann._id}: ${err.message}`)
        )
      )
    );
  }

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
