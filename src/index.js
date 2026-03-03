/**
 * Acquiro Scraper — entry point.
 *
 * Run:  node src/index.js
 *
 * Scrapes the first 3 pages of new business listings from Rightbiz.co.uk,
 * prints each listing's structured data to the console, and exits.
 */

import { RightbizScraper } from './scrapers/rightbiz.js';

const MAX_PAGES = 3;

async function main() {
  console.log('═'.repeat(80));
  console.log('  Acquiro Scraper — Rightbiz.co.uk');
  console.log(`  Scraping ${MAX_PAGES} pages of new UK business listings`);
  console.log('═'.repeat(80));
  console.log();

  const scraper = new RightbizScraper();

  const listings = await scraper.scrape(MAX_PAGES);

  console.log();
  console.log('═'.repeat(80));
  console.log(`  COMPLETE — ${listings.length} listings extracted`);
  console.log('═'.repeat(80));
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
