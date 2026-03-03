const ENDPOINT = 'https://toby-85612.bubbleapps.io/version-test/api/1.1/wf/insert_listing';

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
