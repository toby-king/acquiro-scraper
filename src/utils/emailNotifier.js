/**
 * Daily email notification system.
 *
 * For each active subscriber:
 *   1. Fetch today's new matches (created in last 24h).
 *   2. If none, fall back to top 5 non-dismissed matches.
 *   3. Fetch business details for each match.
 *   4. Generate a personalised HTML email via OpenAI.
 *   5. POST to Zapier webhook (sends the email).
 *   6. Write an Email record to Bubble.
 */

import OpenAI from 'openai';
import {
  getActiveSubscribers,
  getUserDetails,
  getAgentForUser,
  getTodaysMatchesForUser,
  getTopMatchesForUser,
  getBusinessById,
  createEmailRecord,
} from './bubbleClient.js';

const ZAPIER_WEBHOOK = process.env.ZAPIER_WEBHOOK_URL;

function log(msg) {
  console.log(`[EmailNotifier] ${msg}`);
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

function formatBusinessForPrompt(business, score) {
  if (!business) return null;
  const name    = business.business_name_text ?? business.title_text ?? 'Unknown Business';
  const price   = business.asking_price_text ?? business.asking_price_number ?? 'POA';
  const sector  = business.sector_text ?? 'Unknown sector';
  const loc     = business.location_text ?? 'UK';
  const desc    = (business.description_text ?? '').slice(0, 300).trim();
  const url     = business.url_text ?? '';
  const pct     = score != null ? `${Math.round(score * 100)}%` : null;

  const lines = [
    `• ${name}`,
    `  Sector: ${sector} | Location: ${loc} | Asking: £${price}`,
    pct ? `  Match score: ${pct}` : null,
    desc ? `  ${desc}${desc.length === 300 ? '…' : ''}` : null,
    url ? `  View listing: ${url}` : null,
  ];
  return lines.filter(Boolean).join('\n');
}

async function generateEmailBody({ agentName, matches, isNewMatches }) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const matchesText = matches
    .map((m, i) => `${i + 1}. ${m}`)
    .join('\n\n');

  const context = isNewMatches
    ? `You have found ${matches.length} new acquisition opportunit${matches.length === 1 ? 'y' : 'ies'} for the user today.`
    : `There are no new matches today. Remind the user you are still searching, and surface these top matches from their existing pipeline as a reminder:`;

  const prompt = `You are ${agentName}, an AI M&A advisor on the Acquiro platform. Write a short, professional and warm daily email update to the user.

${context}

${matchesText}

Instructions:
- Write in first person as ${agentName}.
- Keep the tone professional but approachable.
- For new matches: highlight why each opportunity is interesting.
- For reminders: encourage the user to revisit these top opportunities.
- End with a brief encouraging note.
- Return clean HTML (no \`\`\`html wrapper). Use <p>, <ul>, <li>, <strong> tags only.
- Do not include subject line, To/From headers, or signatures.`;

  const response = await openai.responses.create({
    model: 'gpt-4o-mini',
    input: prompt,
  });

  return response.output_text ?? response.output?.[0]?.content?.[0]?.text ?? '';
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

  // 2. Agent name
  const agent = await getAgentForUser(userId);
  const agentName = agent?.name_text ?? agent?.agent_name_text ?? 'Your Acquiro Advisor';

  // 3. Today's matches
  let matchRecords = await getTodaysMatchesForUser(userId);
  let isNewMatches = matchRecords.length > 0;

  // 4. Fallback: top non-dismissed matches
  if (!isNewMatches) {
    matchRecords = await getTopMatchesForUser(userId, 5);
    if (matchRecords.length === 0) {
      log(`user=${userId} has no matches at all — skipping`);
      return { skipped: true, reason: 'no matches' };
    }
  }

  // 5. Fetch business details
  const businessPromises = matchRecords.map((m) => fetchBusinessDetails(m));
  const businesses = await Promise.all(businessPromises);

  const formattedMatches = matchRecords
    .map((m, i) => {
      const score = m.score_number ?? null;
      return formatBusinessForPrompt(businesses[i], score);
    })
    .filter(Boolean);

  if (formattedMatches.length === 0) {
    log(`user=${userId} — could not format any business details — skipping`);
    return { skipped: true, reason: 'no business details' };
  }

  // 6. Generate email body
  const emailBody = await generateEmailBody({ agentName, matches: formattedMatches, isNewMatches });

  // 7. POST to Zapier
  const threadId = `${userId}_${new Date().toISOString().slice(0, 10)}`;

  if (!ZAPIER_WEBHOOK) throw new Error('ZAPIER_WEBHOOK_URL env var is not set');

  const zapierRes = await fetch(ZAPIER_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      body: emailBody,
      agent_name: agentName,
      user_email: email,
      thread_id: threadId,
    }),
  });

  if (!zapierRes.ok) {
    throw new Error(`Zapier webhook returned HTTP ${zapierRes.status}`);
  }

  log(`Email sent via Zapier for user=${userId} (${isNewMatches ? matchRecords.length + ' new matches' : 'top matches reminder'})`);

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
