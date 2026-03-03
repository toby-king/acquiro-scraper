/**
 * Acquiro Scraper — entry point.
 *
 * Run:  node src/index.js
 *
 * Prompts for the number of pages to scrape, then scrapes new UK business
 * listings from Rightbiz.co.uk and prints each listing to the console.
 * Enter 0 to scrape all available pages.
 */

import { createInterface } from 'readline/promises';
import { RightbizScraper } from './scrapers/rightbiz.js';

async function promptPageCount() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const answer = await rl.question('  How many pages to scrape? (0 = all): ');
      const n = parseInt(answer.trim(), 10);
      if (!isNaN(n) && n >= 0) return n;
      console.log('  Please enter a whole number (0 or more).');
    }
  } finally {
    rl.close();
  }
}

async function main() {
  console.log('═'.repeat(80));
  console.log('  Acquiro Scraper — Rightbiz.co.uk');
  console.log('═'.repeat(80));
  console.log();

  const pageCount = await promptPageCount();
  const maxPages = pageCount === 0 ? Infinity : pageCount;
  const label = pageCount === 0 ? 'all available' : String(pageCount);

  console.log();
  console.log(`  Scraping ${label} pages of new UK business listings…`);
  console.log();

  const scraper = new RightbizScraper();

  const listings = await scraper.scrape(maxPages);

  console.log();
  console.log('═'.repeat(80));
  console.log(`  COMPLETE — ${listings.length} listings extracted`);
  console.log('═'.repeat(80));
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
