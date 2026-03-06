const BUBBLE_BASE = 'https://toby-85612.bubbleapps.io/version-test/api/1.1';
const ENDPOINT = `${BUBBLE_BASE}/wf/insert_listing`;

export async function insertListing(listing) {
  const apiKey = process.env.BUBBLE_API_KEY;
  if (!apiKey) throw new Error('BUBBLE_API_KEY env var is not set');

  console.log(`[bubble] insertListing → ${ENDPOINT} listing_id=${listing.listing_id}`);
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(listing),
  });

  console.log(`[bubble] insertListing response status=${res.status}`);
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Bubble insert_listing returned HTTP ${res.status}: ${errText.substring(0, 200)}`);
  }
  const insertText = await res.text();
  console.log(`[bubble] insertListing body="${insertText.substring(0, 200)}"`);
  if (!insertText.trim()) throw new Error('Bubble insert_listing returned empty response body (status ' + res.status + ')');
  try {
    return JSON.parse(insertText);
  } catch (e) {
    throw new Error(`Bubble insert_listing JSON parse failed. Body: ${insertText.substring(0, 200)}`);
  }
}

export async function checkListingExists(listing_id) {
  const apiKey = process.env.BUBBLE_API_KEY;
  if (!apiKey) throw new Error('BUBBLE_API_KEY env var is not set');

  const constraints = JSON.stringify([
    { key: 'listing_id_text', constraint_type: 'equals', value: listing_id },
  ]);
  const url = `${BUBBLE_BASE}/obj/Business?constraints=${encodeURIComponent(constraints)}`;

  console.log(`[bubble] checkListingExists listing_id=${listing_id}`);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  console.log(`[bubble] checkListingExists response status=${res.status}`);
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Bubble checkListingExists returned HTTP ${res.status}: ${errText.substring(0, 200)}`);
  }
  const checkText = await res.text();
  if (!checkText.trim()) throw new Error('Bubble checkListingExists returned empty response body (status ' + res.status + ')');
  try {
    const json = JSON.parse(checkText);
    return (json.response?.count ?? 0) > 0;
  } catch (e) {
    throw new Error(`Bubble checkListingExists JSON parse failed. Body: ${checkText.substring(0, 200)}`);
  }
}

export async function getStaleListings(cursor = 0) {
  const apiKey = process.env.BUBBLE_API_KEY;
  if (!apiKey) throw new Error('BUBBLE_API_KEY env var is not set');

  const staleThreshold = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
  const constraints = JSON.stringify([
    { key: 'archived',     constraint_type: 'equals',    value: false },
    { key: 'last_seen_at', constraint_type: 'less than', value: staleThreshold },
  ]);
  const url = `${BUBBLE_BASE}/obj/Business?constraints=${encodeURIComponent(constraints)}&limit=100&cursor=${cursor}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!res.ok) throw new Error(`Bubble getStaleListings returned HTTP ${res.status}`);
  const json = await res.json();
  return json.response; // { results, remaining, count }
}

export async function archiveListing(bubbleId) {
  const apiKey = process.env.BUBBLE_API_KEY;
  if (!apiKey) throw new Error('BUBBLE_API_KEY env var is not set');

  const res = await fetch(`${BUBBLE_BASE}/obj/Business/${bubbleId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ archived: true }),
  });

  if (!res.ok) throw new Error(`Bubble archiveListing returned HTTP ${res.status}`);
  return res.json();
}

export async function touchListing(bubbleId) {
  const apiKey = process.env.BUBBLE_API_KEY;
  if (!apiKey) throw new Error('BUBBLE_API_KEY env var is not set');

  const now = new Date().toISOString();
  const res = await fetch(`${BUBBLE_BASE}/obj/Business/${bubbleId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ last_seen_at_date: now, last_verified_at_date: now }),
  });

  if (!res.ok) throw new Error(`Bubble touchListing returned HTTP ${res.status}`);
  return res.json();
}

export async function getExistingMatches(userId) {
  const apiKey = process.env.BUBBLE_API_KEY;
  if (!apiKey) throw new Error('BUBBLE_API_KEY env var is not set');

  const constraints = JSON.stringify([
    { key: 'user_user', constraint_type: 'equals', value: userId },
  ]);

  const ids = [];
  let cursor = 0;

  while (true) {
    const url = `${BUBBLE_BASE}/obj/matches?constraints=${encodeURIComponent(constraints)}&limit=100&cursor=${cursor}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) throw new Error(`Bubble getExistingMatches returned HTTP ${res.status}`);
    const json = await res.json();
    const { results, remaining } = json.response;
    results.forEach((m) => { if (m.business_custom_business) ids.push(m.business_custom_business); });
    if (!remaining || remaining === 0) break;
    cursor += results.length;
  }

  return ids;
}

export async function getBubbleIdByListingId(listing_id) {
  const apiKey = process.env.BUBBLE_API_KEY;
  if (!apiKey) throw new Error('BUBBLE_API_KEY env var is not set');

  const constraints = JSON.stringify([
    { key: 'listing_id_text', constraint_type: 'equals', value: listing_id },
  ]);
  const url = `${BUBBLE_BASE}/obj/Business?constraints=${encodeURIComponent(constraints)}&limit=1`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  const text = await res.text();
  console.log(`[bubble] getBubbleIdByListingId status=${res.status} body="${text.substring(0, 100)}"`);
  if (!res.ok) throw new Error(`Bubble getBubbleIdByListingId returned HTTP ${res.status}: ${text.substring(0, 200)}`);
  if (!text.trim()) return null;
  const json = JSON.parse(text);
  return json.response?.results?.[0]?._id ?? null;
}

export async function getActiveSubscribers() {
  const apiKey = process.env.BUBBLE_API_KEY;
  if (!apiKey) throw new Error('BUBBLE_API_KEY env var is not set');

  const constraints = JSON.stringify([
    { key: 'is_subscribed_boolean', constraint_type: 'equals', value: true },
  ]);

  const ids = [];
  let cursor = 0;

  while (true) {
    const url = `${BUBBLE_BASE}/obj/user?constraints=${encodeURIComponent(constraints)}&limit=100&cursor=${cursor}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) throw new Error(`Bubble getActiveSubscribers returned HTTP ${res.status}`);
    const json = await res.json();
    const { results, remaining } = json.response;
    results.forEach((u) => { if (u._id) ids.push(u._id); });
    if (!remaining || remaining === 0) break;
    cursor += results.length;
  }

  return ids;
}

export async function createScrapeLog({ added, archived, matches }) {
  const apiKey = process.env.BUBBLE_API_KEY;
  if (!apiKey) throw new Error('BUBBLE_API_KEY env var is not set');

  const res = await fetch(`${BUBBLE_BASE}/obj/Scrape_Log`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      last_run: new Date().toISOString(),
      records_added: added,
      records_archived: archived,
      matches_made: matches,
    }),
  });

  if (!res.ok) throw new Error(`Bubble createScrapeLog returned HTTP ${res.status}`);
  return res.json();
}

export async function getLatestScrapeLog() {
  const apiKey = process.env.BUBBLE_API_KEY;
  if (!apiKey) throw new Error('BUBBLE_API_KEY env var is not set');

  const url = `${BUBBLE_BASE}/obj/Scrape_Log?sort_field=last_run_date&descending=true&limit=1`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });

  if (!res.ok) throw new Error(`Bubble getLatestScrapeLog returned HTTP ${res.status}`);
  const json = await res.json();
  return json.response?.results?.[0] ?? null;
}

export async function getUserDetails(userId) {
  const apiKey = process.env.BUBBLE_API_KEY;
  if (!apiKey) throw new Error('BUBBLE_API_KEY env var is not set');

  const res = await fetch(`${BUBBLE_BASE}/obj/user/${userId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`Bubble getUserDetails returned HTTP ${res.status}`);
  const json = await res.json();
  return json.response;
}

export async function getAgentForUser(userId) {
  const apiKey = process.env.BUBBLE_API_KEY;
  if (!apiKey) throw new Error('BUBBLE_API_KEY env var is not set');

  const constraints = JSON.stringify([
    { key: 'user_user', constraint_type: 'equals', value: userId },
  ]);
  const url = `${BUBBLE_BASE}/obj/Agents?constraints=${encodeURIComponent(constraints)}&limit=1`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`Bubble getAgentForUser returned HTTP ${res.status}`);
  const json = await res.json();
  return json.response?.results?.[0] ?? null;
}

export async function getTodaysMatchesForUser(userId) {
  const apiKey = process.env.BUBBLE_API_KEY;
  if (!apiKey) throw new Error('BUBBLE_API_KEY env var is not set');

  // Matches created in the last 36 hours (pipeline runs at 2am, emails at 8am)
  const since = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();
  const constraints = JSON.stringify([
    { key: 'user_user', constraint_type: 'equals', value: userId },
    { key: 'Created Date', constraint_type: 'greater than', value: since },
  ]);
  const url = `${BUBBLE_BASE}/obj/matches?constraints=${encodeURIComponent(constraints)}&limit=100`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`Bubble getTodaysMatchesForUser returned HTTP ${res.status}`);
  const json = await res.json();
  return json.response?.results ?? [];
}

export async function getTopMatchesForUser(userId, limit = 5) {
  const apiKey = process.env.BUBBLE_API_KEY;
  if (!apiKey) throw new Error('BUBBLE_API_KEY env var is not set');

  const constraints = JSON.stringify([
    { key: 'user_user', constraint_type: 'equals', value: userId },
    { key: 'dismissed', constraint_type: 'equals', value: false },
  ]);
  const url = `${BUBBLE_BASE}/obj/matches?constraints=${encodeURIComponent(constraints)}&sort_field=score_number&descending=true&limit=${limit}`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`Bubble getTopMatchesForUser returned HTTP ${res.status}`);
  const json = await res.json();
  return json.response?.results ?? [];
}

export async function getBusinessById(bubbleId) {
  const apiKey = process.env.BUBBLE_API_KEY;
  if (!apiKey) throw new Error('BUBBLE_API_KEY env var is not set');

  const res = await fetch(`${BUBBLE_BASE}/obj/Business/${bubbleId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`Bubble getBusinessById returned HTTP ${res.status}`);
  const json = await res.json();
  return json.response;
}

export async function createEmailRecord({ body, threadId, userId }) {
  const apiKey = process.env.BUBBLE_API_KEY;
  if (!apiKey) throw new Error('BUBBLE_API_KEY env var is not set');

  const res = await fetch(`${BUBBLE_BASE}/obj/Emails`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      body_text: body,
      is_agent_boolean: true,
      thread_id_text: threadId,
      user_user: userId,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Bubble createEmailRecord returned HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

export async function getAgentByEmail(agentEmail) {
  const apiKey = process.env.BUBBLE_API_KEY;
  if (!apiKey) throw new Error('BUBBLE_API_KEY env var is not set');

  const constraints = JSON.stringify([
    { key: 'email_text', constraint_type: 'equals', value: agentEmail },
  ]);
  const url = `${BUBBLE_BASE}/obj/Agents?constraints=${encodeURIComponent(constraints)}&limit=1`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`Bubble getAgentByEmail returned HTTP ${res.status}`);
  const json = await res.json();
  return json.response?.results?.[0] ?? null;
}

export async function checkOutreachExists(userId, listingId) {
  const apiKey = process.env.BUBBLE_API_KEY;
  if (!apiKey) throw new Error('BUBBLE_API_KEY env var is not set');

  const constraints = JSON.stringify([
    { key: 'user_user', constraint_type: 'equals', value: userId },
    { key: 'listing_id_text', constraint_type: 'equals', value: listingId },
  ]);
  const url = `${BUBBLE_BASE}/obj/LangcliffeOutreach?constraints=${encodeURIComponent(constraints)}&limit=1`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`Bubble checkOutreachExists returned HTTP ${res.status}`);
  const json = await res.json();
  return (json.response?.count ?? 0) > 0;
}

export async function createOutreachDraft({ userId, listingId, langcliffeContact, businessName, draftBody }) {
  const apiKey = process.env.BUBBLE_API_KEY;
  if (!apiKey) throw new Error('BUBBLE_API_KEY env var is not set');

  const res = await fetch(`${BUBBLE_BASE}/obj/LangcliffeOutreach`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      user_user: userId,
      listing_id_text: listingId,
      langcliffe_contact_text: langcliffeContact,
      business_name_text: businessName,
      draft_body_text: draftBody,
      status_text: 'pending',
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Bubble createOutreachDraft returned HTTP ${res.status}: ${text}`);
  }
  const json = await res.json();
  return json.response?.id ?? json.id;
}

export async function getLangcliffeOutreach(outreachId) {
  const apiKey = process.env.BUBBLE_API_KEY;
  if (!apiKey) throw new Error('BUBBLE_API_KEY env var is not set');

  const res = await fetch(`${BUBBLE_BASE}/obj/LangcliffeOutreach/${outreachId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`Bubble getLangcliffeOutreach returned HTTP ${res.status}`);
  const json = await res.json();
  return json.response;
}

export async function getPendingOutreachQueue() {
  const apiKey = process.env.BUBBLE_API_KEY;
  if (!apiKey) throw new Error('BUBBLE_API_KEY env var is not set');

  const constraints = JSON.stringify([
    { key: 'status_text', constraint_type: 'equals', value: 'pending' },
  ]);
  const url = `${BUBBLE_BASE}/obj/LangcliffeOutreach?constraints=${encodeURIComponent(constraints)}&sort_field=Created Date&descending=true`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`Bubble getPendingOutreachQueue returned HTTP ${res.status}`);
  const json = await res.json();
  return json.response?.results ?? [];
}

export async function approveOutreach(outreachId) {
  const apiKey = process.env.BUBBLE_API_KEY;
  if (!apiKey) throw new Error('BUBBLE_API_KEY env var is not set');

  const res = await fetch(`${BUBBLE_BASE}/obj/LangcliffeOutreach/${outreachId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ status_text: 'sent', sent_at_date: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`Bubble approveOutreach returned HTTP ${res.status}`);
  return res.json();
}

export async function rejectOutreach(outreachId, newDraftBody) {
  const apiKey = process.env.BUBBLE_API_KEY;
  if (!apiKey) throw new Error('BUBBLE_API_KEY env var is not set');

  const res = await fetch(`${BUBBLE_BASE}/obj/LangcliffeOutreach/${outreachId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ draft_body_text: newDraftBody, status_text: 'pending' }),
  });
  if (!res.ok) throw new Error(`Bubble rejectOutreach returned HTTP ${res.status}`);
  return res.json();
}

export async function getBuyerInfo(userId) {
  const apiKey = process.env.BUBBLE_API_KEY;
  if (!apiKey) throw new Error('BUBBLE_API_KEY env var is not set');

  const constraints = JSON.stringify([
    { key: 'user_user', constraint_type: 'equals', value: userId },
  ]);
  const url = `${BUBBLE_BASE}/obj/Buyer_Info?constraints=${encodeURIComponent(constraints)}&sort_field=Created Date&descending=true&limit=1`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`Bubble getBuyerInfo returned HTTP ${res.status}`);
  const json = await res.json();
  return json.response; // { results, count, remaining }
}
