/**
 * BaseScraper — abstract base class for all site scrapers.
 *
 * Responsibilities:
 *  - Stealth browser lifecycle (launch / close)
 *  - Concurrency control via a bounded semaphore (default: 2 contexts)
 *  - Per-request rate-limiting (delegated to rateLimiter utility)
 *  - Retry with exponential back-off + jitter
 *  - Human-like scroll on every page load
 *  - Pretty-printing of extracted listings
 *
 * Subclasses must implement:
 *  - getListingUrlsForPage(pageNum)  → string[]
 *  - extractDetails(html, url)       → object | null
 */

import { launchBrowser, createContext, humanScroll } from '../utils/browser.js';
import { rateLimit, sleep, randomInt } from '../utils/rateLimiter.js';

// Base delays (ms) for exponential back-off: attempt 0→2 s, 1→4 s, 2→8 s
const BACKOFF_BASE_MS = [2000, 4000, 8000];

// ─── Semaphore ────────────────────────────────────────────────────────────────

class Semaphore {
  constructor(max) {
    this._max = max;
    this._active = 0;
    this._queue = [];
  }

  /** Acquire a slot; waits if all slots are busy. */
  _acquire() {
    return new Promise((resolve) => {
      if (this._active < this._max) {
        this._active++;
        resolve();
      } else {
        this._queue.push(resolve);
      }
    });
  }

  /** Release a slot and wake the next waiter if any. */
  _release() {
    this._active--;
    if (this._queue.length > 0) {
      this._active++;
      this._queue.shift()();
    }
  }

  /** Run `fn` inside a semaphore slot; always releases on finish. */
  async run(fn) {
    await this._acquire();
    try {
      return await fn();
    } finally {
      this._release();
    }
  }
}

// ─── BaseScraper ──────────────────────────────────────────────────────────────

export class BaseScraper {
  /**
   * @param {object} config
   * @param {string}  config.name          Human-readable site name.
   * @param {string}  config.startUrl      URL of the first search-results page.
   * @param {number} [config.maxConcurrency=2]  Max parallel browser contexts.
   */
  constructor(config) {
    this.name = config.name;
    this.startUrl = config.startUrl;
    this.maxConcurrency = config.maxConcurrency ?? 2;

    this._browser = null;
    this._semaphore = new Semaphore(this.maxConcurrency);
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  async _init() {
    this._browser = await launchBrowser();
  }

  async _teardown() {
    if (this._browser) {
      await this._browser.close();
      this._browser = null;
    }
  }

  // ── Core HTTP helper ────────────────────────────────────────────────────────

  /**
   * Fetch `url` with a fresh stealth context.
   * Rate-limited, retried with exponential back-off + jitter.
   * @param {string} url
   * @returns {Promise<string>}  Full HTML of the page.
   */
  async _fetchPage(url) {
    await rateLimit(url);

    return this._withRetry(async () => {
      const context = await createContext(this._browser);
      const page = await context.newPage();

      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await humanScroll(page);
        return await page.content();
      } finally {
        await context.close();
      }
    });
  }

  // ── Retry helper ────────────────────────────────────────────────────────────

  /**
   * Run `fn` up to 3 times with exponential back-off + jitter on failure.
   * @param {() => Promise<any>} fn
   * @param {number} [maxAttempts=3]
   */
  async _withRetry(fn, maxAttempts = 3) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const isLast = attempt === maxAttempts - 1;
        if (isLast) throw err;

        const base = BACKOFF_BASE_MS[attempt] ?? 8000;
        const jitter = randomInt(0, 1000);
        const wait = base + jitter;

        this._log(`Attempt ${attempt + 1} failed: ${err.message}. Retrying in ${wait}ms…`);
        await sleep(wait);
      }
    }
  }

  // ── Logging ──────────────────────────────────────────────────────────────────

  _log(msg) {
    console.log(`[${this.name}] ${msg}`);
  }

  _error(msg) {
    console.error(`[${this.name}] ERROR: ${msg}`);
  }

  // ── Abstract interface (must be overridden by subclasses) ───────────────────

  /**
   * Return an array of absolute listing-page URLs found on the given page number.
   * @param {number} pageNum  1-based page number.
   * @returns {Promise<string[]>}
   */
  // eslint-disable-next-line no-unused-vars
  async getListingUrlsForPage(pageNum) {
    throw new Error(`${this.name}: getListingUrlsForPage() not implemented`);
  }

  /**
   * Parse `html` (the rendered HTML of an individual listing page) and return
   * a structured object with all available fields, or null on failure.
   * @param {string} html
   * @param {string} url
   * @returns {object | null}
   */
  // eslint-disable-next-line no-unused-vars
  extractDetails(html, url) {
    throw new Error(`${this.name}: extractDetails() not implemented`);
  }

  // ── Orchestration ────────────────────────────────────────────────────────────

  /**
   * Run the full scrape: collect URLs from `maxPages` pages, then scrape every
   * individual listing with bounded concurrency, printing results as they arrive.
   * @param {number} [maxPages=3]
   * @returns {Promise<object[]>}  Array of extracted listing objects.
   */
  async scrape(maxPages = 3) {
    await this._init();

    try {
      // ── Phase 1: collect listing URLs ─────────────────────────────────────
      this._log(`Collecting listing URLs from ${maxPages} pages…`);
      const listingUrls = [];

      for (let p = 1; p <= maxPages; p++) {
        let urls;
        try {
          urls = await this.getListingUrlsForPage(p);
        } catch (err) {
          this._error(`Failed to load page ${p}: ${err.message}`);
          break;
        }

        if (!urls || urls.length === 0) {
          this._log(`Page ${p} returned no listings — stopping pagination.`);
          break;
        }

        listingUrls.push(...urls);
        this._log(`Page ${p}: ${urls.length} listings found (running total: ${listingUrls.length})`);
      }

      if (listingUrls.length === 0) {
        this._log('No listing URLs collected. Exiting.');
        return [];
      }

      // ── Phase 2: scrape each listing in parallel (bounded) ────────────────
      this._log(`\nScraping ${listingUrls.length} listings (max ${this.maxConcurrency} concurrent)…\n`);

      const results = await Promise.all(
        listingUrls.map((url, idx) =>
          this._semaphore.run(async () => {
            this._log(`[${idx + 1}/${listingUrls.length}] Fetching: ${url}`);
            try {
              const html = await this._fetchPage(url);
              const details = this.extractDetails(html, url);
              if (details) this._printListing(details, idx + 1);
              return details;
            } catch (err) {
              this._error(`Failed to scrape ${url}: ${err.message}`);
              return null;
            }
          }),
        ),
      );

      const scraped = results.filter(Boolean);
      this._log(`\nDone. Successfully scraped ${scraped.length}/${listingUrls.length} listings.`);
      return scraped;
    } finally {
      await this._teardown();
    }
  }

  // ── Output ────────────────────────────────────────────────────────────────

  /**
   * Pretty-print a single extracted listing to stdout.
   * @param {object} listing
   * @param {number} idx  1-based index for display.
   */
  _printListing(listing, idx) {
    const DIVIDER = '═'.repeat(80);
    const lines = [];

    lines.push('');
    lines.push(DIVIDER);
    lines.push(`LISTING #${idx}  —  ${listing.title ?? '(no title)'}`);
    lines.push(DIVIDER);

    const FIELDS = [
      ['URL', 'url'],
      ['Location', 'location'],
      ['Price', 'price'],
      ['Tenure', 'tenure'],
      ['Turnover', 'turnover'],
      ['Net Profit', 'netProfit'],
      ['Sector', 'sector'],
    ];

    for (const [label, key] of FIELDS) {
      const val = listing[key];
      if (val) {
        lines.push(`${label.padEnd(14)}: ${val}`);
      }
    }

    if (listing.description) {
      const snippet =
        listing.description.length > 300
          ? listing.description.slice(0, 300).trimEnd() + '…'
          : listing.description;
      lines.push(`${'Description'.padEnd(14)}: ${snippet}`);
    }

    lines.push(DIVIDER);

    console.log(lines.join('\n'));
  }
}
