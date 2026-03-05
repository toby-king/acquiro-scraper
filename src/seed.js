import { RightbizScraper }          from './scrapers/rightbiz.js';
import { CoGoGoScraper }            from './scrapers/cogogo.js';
import { DaltonsScraper }           from './scrapers/daltons.js';
import { BusinessesForSaleScraper } from './scrapers/businessesforsale.js';
import { checkListingExists }       from './utils/bubbleClient.js';
import { processAndIndexListing }   from './utils/indexer.js';
import { getListingIdFromUrl }      from './utils/listingId.js';

const MAX_PAGES          = 40;
const TRACER_BULLET      = Infinity;
const POST_LOOP_DELAY_MS = 5000;

const SCRAPERS = [
  new RightbizScraper(),
  new CoGoGoScraper(),
  new DaltonsScraper(),
  new BusinessesForSaleScraper(),
];

async function main() {
  // ── Init all scrapers (launches browsers) ──────────────────────────────────
  for (const s of SCRAPERS) await s._init();

  // ── Phase 1: Search Sweep — collect {url, listing_id, scraper} queue ───────
  console.log(`\nPhase 1: sweeping ${SCRAPERS.length} scrapers × ${MAX_PAGES} pages…\n`);
  const pendingQueue = [];

  for (const scraper of SCRAPERS) {
    for (let page = 1; page <= MAX_PAGES; page++) {
      let urls;
      try {
        urls = await scraper.getListingUrlsForPage(page);
      } catch (err) {
        console.error(`[${scraper.name}] Page ${page} failed: ${err.message}`);
        break;
      }
      if (!urls || urls.length === 0) break;

      for (const url of urls) {
        pendingQueue.push({ url, listing_id: getListingIdFromUrl(url), scraper });
      }
      console.log(`[${scraper.name}] Page ${page}: ${urls.length} URLs (queue: ${pendingQueue.length})`);
    }
  }

  console.log(`\nPhase 1 complete — ${pendingQueue.length} listings queued.\n`);

  // ── Phase 2: Sequential Loop ───────────────────────────────────────────────
  let successCount = 0;

  for (const { url, listing_id, scraper } of pendingQueue) {
    if (successCount >= TRACER_BULLET) {
      console.log(`\nTracer bullet reached (${TRACER_BULLET} inserted). Stopping.`);
      break;
    }

    // Path A — listing_id known from URL (CoGoGo, Daltons, Rightbiz):
    //   check Bubble BEFORE fetching the detail page.
    if (listing_id) {
      try {
        const exists = await checkListingExists(listing_id);
        if (exists) {
          console.log(`[${scraper.name}] Skipping existing listing: ${listing_id}`);
          await new Promise(r => setTimeout(r, POST_LOOP_DELAY_MS));
          continue;
        }
      } catch (err) {
        console.error(`[${scraper.name}] Bubble check failed for ${listing_id}: ${err.message}`);
        // fall through — attempt the detail scrape anyway
      }
    }

    // The Deep Scrape (all paths reach here)
    let details;
    try {
      details = await scraper.scrapeDetail(url);
    } catch (err) {
      console.error(`[${scraper.name}] Detail fetch failed for ${url}: ${err.message}`);
      await new Promise(r => setTimeout(r, POST_LOOP_DELAY_MS));
      continue;
    }
    if (!details) {
      await new Promise(r => setTimeout(r, POST_LOOP_DELAY_MS));
      continue;
    }

    // Path B — listing_id was null (BFS): check Bubble NOW using the ID
    //   extracted from the detail page HTML.
    if (!listing_id && details.listing_id) {
      try {
        const exists = await checkListingExists(details.listing_id);
        if (exists) {
          console.log(`[${scraper.name}] Skipping existing listing: ${details.listing_id}`);
          await new Promise(r => setTimeout(r, POST_LOOP_DELAY_MS));
          continue;
        }
      } catch (err) {
        console.error(`[${scraper.name}] Bubble check failed for ${details.listing_id}: ${err.message}`);
        // fall through — attempt insert
      }
    }

    // The Create + Vectorise
    try {
      const bubbleId = await processAndIndexListing(details);
      successCount++;
      console.log(`[${scraper.name}] [${successCount}/${TRACER_BULLET}] Inserted — Bubble ID: ${bubbleId}`);
    } catch (err) {
      console.error(`[${scraper.name}] Ingestion failed for ${url}: ${err.message}`);
    }

    await new Promise(r => setTimeout(r, POST_LOOP_DELAY_MS));
  }

  // ── Teardown ───────────────────────────────────────────────────────────────
  for (const s of SCRAPERS) await s._teardown().catch(() => {});

  console.log(`\nSeed complete. ${successCount} listing(s) inserted.`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
