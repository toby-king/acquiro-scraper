import * as cheerio from 'cheerio';
import { getStaleListings, archiveListing, touchListing } from './utils/bubbleClient.js';

const CHECK_DELAY  = 2000;  // ms between URL checks
const MIN_PATH_LENGTH = 15; // shorter final path → likely redirected to home/search

const SOLD_PATTERNS = [
  /\bsold\b/i,
  /under offer/i,
  /listing expired/i,
  /\bcompleted\b/i,
];

function log(msg) {
  console.log(`[Archiver] ${msg}`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function checkUrl(url) {
  let res;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { outcome: 'skip', reason: 'network error' };
  }

  const { status } = res;

  if (status >= 500) {
    return { outcome: 'skip', reason: `server error ${status}` };
  }

  if (status === 404 || status === 410) {
    return { outcome: 'archive', reason: `Page ${status}` };
  }

  // Redirect-to-home/search heuristic
  const finalPath = new URL(res.url).pathname;
  const origPath  = new URL(url).pathname;
  if (finalPath !== origPath && finalPath.length < MIN_PATH_LENGTH) {
    return { outcome: 'archive', reason: 'Redirected to search/home' };
  }

  if (status === 200) {
    const body = await res.text();
    const $ = cheerio.load(body);
    const pageText = $('body').text();
    for (const pattern of SOLD_PATTERNS) {
      const match = pageText.match(pattern);
      if (match) {
        return { outcome: 'archive', reason: match[0].toLowerCase() };
      }
    }
    return { outcome: 'alive' };
  }

  // 403 Cloudflare, 429, etc. — can't verify, don't archive
  return { outcome: 'skip', reason: `HTTP ${status}` };
}

async function main() {
  let cursor = 0;
  let totalArchived = 0;
  let totalTouched  = 0;
  let totalSkipped  = 0;

  while (true) {
    log(`Fetching stale records (cursor ${cursor})…`);
    const page = await getStaleListings(cursor);
    const { results, remaining } = page;

    log(`${results.length} stale listings to check.`);

    for (const record of results) {
      const id = record.listing_id ?? record._id;

      const { outcome, reason } = await checkUrl(record.url);

      if (outcome === 'archive') {
        await archiveListing(record._id);
        log(`Archiving ${id}: ${reason}`);
        totalArchived++;
      } else if (outcome === 'alive') {
        await touchListing(record._id);
        log(`Still alive: ${id}`);
        totalTouched++;
      } else {
        log(`Skipping ${id}: ${reason}`);
        totalSkipped++;
      }

      await sleep(CHECK_DELAY);
    }

    if (!remaining || remaining === 0) break;
    cursor += results.length;
  }

  log(`Done. Archived: ${totalArchived} | Touched: ${totalTouched} | Skipped: ${totalSkipped}`);
}

main().catch(err => {
  console.error('[Archiver] Fatal error:', err);
  process.exit(1);
});
