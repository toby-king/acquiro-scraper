/**
 * Acquiro Scraper — entry point.
 *
 * Run:  node src/index.js
 *
 * Prompts for which site(s) to scrape and how many pages, then prints
 * each extracted listing to the console.
 */

import { createInterface } from 'readline/promises';
import { RightbizScraper } from './scrapers/rightbiz.js';
import { CoGoGoScraper } from './scrapers/cogogo.js';
import { DaltonsScraper } from './scrapers/daltons.js';
import { BusinessesForSaleScraper } from './scrapers/businessesforsale.js';

const SCRAPERS = [
  { label: 'Rightbiz.co.uk',           factory: () => new RightbizScraper() },
  { label: 'CoGoGo (letscogogo.com)',   factory: () => new CoGoGoScraper() },
  { label: 'Daltons Business',          factory: () => new DaltonsScraper() },
  { label: 'BusinessesForSale.com',     factory: () => new BusinessesForSaleScraper() },
];

async function promptScraper(rl) {
  console.log('  Which site would you like to scrape?');
  console.log('    0. All sites');
  SCRAPERS.forEach((s, i) => console.log(`    ${i + 1}. ${s.label}`));
  console.log();

  while (true) {
    const answer = await rl.question('  Choice: ');
    const n = parseInt(answer.trim(), 10);
    if (!isNaN(n) && n >= 0 && n <= SCRAPERS.length) return n;
    console.log(`  Please enter a number between 0 and ${SCRAPERS.length}.`);
  }
}

async function promptPageCount(rl) {
  while (true) {
    const answer = await rl.question('  How many pages to scrape? (0 = all): ');
    const n = parseInt(answer.trim(), 10);
    if (!isNaN(n) && n >= 0) return n;
    console.log('  Please enter a whole number (0 or more).');
  }
}

async function main() {
  console.log('═'.repeat(80));
  console.log('  Acquiro Scraper');
  console.log('═'.repeat(80));
  console.log();

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  let selectedScrapers;
  let pageCount;

  try {
    const choice = await promptScraper(rl);
    selectedScrapers = choice === 0 ? SCRAPERS : [SCRAPERS[choice - 1]];

    console.log();
    pageCount = await promptPageCount(rl);
  } finally {
    rl.close();
  }

  const maxPages = pageCount === 0 ? Infinity : pageCount;
  const label = pageCount === 0 ? 'all available' : String(pageCount);

  console.log();
  console.log(
    `  Scraping ${label} page(s) from: ${selectedScrapers.map((s) => s.label).join(', ')}`,
  );
  console.log();

  let totalListings = 0;

  for (const { label: siteName, factory } of selectedScrapers) {
    console.log('═'.repeat(80));
    console.log(`  ${siteName}`);
    console.log('═'.repeat(80));
    console.log();

    const scraper = factory();
    const listings = await scraper.scrape(maxPages);
    totalListings += listings.length;
  }

  console.log();
  console.log('═'.repeat(80));
  console.log(`  ALL DONE — ${totalListings} listings extracted in total`);
  console.log('═'.repeat(80));
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
