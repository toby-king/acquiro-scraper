const BUBBLE_BASE = 'https://toby-85612.bubbleapps.io/version-test/api/1.1';
const ENDPOINT = `${BUBBLE_BASE}/wf/insert_listing`;

export async function insertListing(listing) {
  const apiKey = process.env.BUBBLE_API_KEY;
  if (!apiKey) throw new Error('BUBBLE_API_KEY env var is not set');

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(listing),
  });

  if (!res.ok) throw new Error(`Bubble API returned HTTP ${res.status}`);
  return res.json();
}

export async function checkListingExists(listing_id) {
  const apiKey = process.env.BUBBLE_API_KEY;
  if (!apiKey) throw new Error('BUBBLE_API_KEY env var is not set');

  const constraints = JSON.stringify([
    { key: 'listing_id', constraint_type: 'equals', value: listing_id },
  ]);
  const url = `${BUBBLE_BASE}/obj/Business?constraints=${encodeURIComponent(constraints)}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!res.ok) throw new Error(`Bubble check returned HTTP ${res.status}`);
  const json = await res.json();
  return (json.response?.count ?? 0) > 0;
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
    body: JSON.stringify({ last_seen_at: now, last_verified_at: now }),
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
    { key: 'listing_id', constraint_type: 'equals', value: listing_id },
  ]);
  const url = `${BUBBLE_BASE}/obj/Business?constraints=${encodeURIComponent(constraints)}&limit=1`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!res.ok) throw new Error(`Bubble getBubbleIdByListingId returned HTTP ${res.status}`);
  const json = await res.json();
  return json.response?.results?.[0]?._id ?? null;
}

export async function getActiveSubscribers() {
  const apiKey = process.env.BUBBLE_API_KEY;
  if (!apiKey) throw new Error('BUBBLE_API_KEY env var is not set');

  const constraints = JSON.stringify([
    { key: 'is_subscribed', constraint_type: 'equals', value: true },
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
