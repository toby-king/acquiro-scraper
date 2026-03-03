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
import { insertListing } from '../utils/bubbleClient.js';

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

  /**
   * Fetch a single listing detail page.
   * Defaults to the stealth Playwright path; subclasses may override this
   * (e.g. for sites that are fully server-rendered and block headless browsers).
   * @param {string} url
   * @returns {Promise<string>}
   */
  async _fetchDetailPage(url) {
    return this._fetchPage(url);
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

  // ── Financial text parser ────────────────────────────────────────────────────

  /**
   * Extract financial figures from a flat description string.
   * Returns a partial object; only fields that matched are included.
   * Intended as a fallback — call after structured extraction and only fill
   * fields that structured HTML didn't populate.
   * @param {string} text
   * @returns {object}
   */
  _parseFinancialsFromText(text) {
    const find = (pattern) => {
      const m = text.match(pattern);
      return m ? m[1].trim() : null;
    };

    const out = {};

    // Separator pattern: [^£\n]{0,20} allows "of", "was", ":", " — ", etc.
    // between the keyword and the £ figure without jumping across sentences.
    const SEP = '[^£\\n]{0,20}';
    const VAL = '(£[\\d,.]+(?:\\s*[km](?:illion)?)?)';
    const re  = (keyword) => new RegExp(`${keyword}${SEP}${VAL}`, 'i');

    const turnover = find(re('(?:annual\\s+)?turnover'));
    if (turnover) out.turnover = turnover;

    const netProfit =
      find(re('net\\s+profit')) ||
      find(re('gross\\s+profit'));
    if (netProfit) out.net_profit = netProfit;

    const ebitda = find(re('ebitda'));
    if (ebitda) out.ebitda = ebitda;

    // \bebit\b so we don't double-match inside "ebitda"
    const ebit = find(new RegExp(`\\bebit\\b${SEP}${VAL}`, 'i'));
    if (ebit) out.ebit = ebit;

    const rent = find(re('rent'));
    if (rent) out.rent = rent;

    const askingPrice = find(re('(?:asking\\s+)?price'));
    if (askingPrice) out.asking_price = askingPrice;

    return out;
  }

  /**
   * Apply text-parsed financials to `result`, filling only fields that are
   * not already populated by structured extraction. Logs any fields filled.
   * @param {object} result  The partially-built listing object (mutated in place).
   */
  _applyTextFinancials(result) {
    if (!result.description) return;
    const found = this._parseFinancialsFromText(result.description);
    const applied = [];
    for (const [field, value] of Object.entries(found)) {
      if (!result[field]) {
        result[field] = value;
        applied.push(`${field}=${value}`);
      }
    }
    if (applied.length > 0) {
      this._log(`Text parser filled: ${applied.join(', ')}`);
    }
  }

  // ── Currency normalisation ───────────────────────────────────────────────────

  /**
   * Parse a currency string into a plain number.
   * Handles: £1,234  £1,234.56  £1.2m  £549k  £1.2million
   * Returns null for non-parseable values ("POA", "On request", etc.).
   * @param {string} str
   * @returns {number | null}
   */
  _parseCurrency(str) {
    if (!str || typeof str !== 'string') return null;
    const m = str.match(/£\s*([\d,]+(?:\.\d+)?)\s*([km](?:illion)?)?/i);
    if (!m) return null;
    let num = parseFloat(m[1].replace(/,/g, ''));
    if (isNaN(num)) return null;
    const suffix = (m[2] ?? '').toLowerCase();
    if (suffix.startsWith('m')) num *= 1_000_000;
    else if (suffix.startsWith('k')) num *= 1_000;
    return num;
  }

  /**
   * Convert all financial string fields on a listing object to plain numbers.
   * Fields that cannot be parsed (e.g. "Price on Application") are removed.
   * Called automatically in scrape() after extractDetails() returns.
   * @param {object} result
   */
  _normaliseFinancials(result) {
    const FIELDS = [
      'asking_price', 'leasehold', 'freehold',
      'turnover', 'net_profit', 'ebit', 'ebitda',
      'rent', 'investment', 'franchise_fee',
    ];
    for (const field of FIELDS) {
      if (!(field in result)) continue;
      const num = this._parseCurrency(result[field]);
      if (num !== null) {
        result[field] = num;
      } else {
        delete result[field];
      }
    }
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
              const html = await this._fetchDetailPage(url);
              const details = this.extractDetails(html, url);
              if (details) {
                details.source = this.name;
                this._normaliseFinancials(details);
                this._printListing(details, idx + 1);
                try {
                  const response = await insertListing(details);
                  this._log(`[${idx + 1}] Inserted — Bubble response: ${JSON.stringify(response)}`);
                  if (response?.response?.listing_id) details.db_id = response.response.listing_id;
                } catch (err) {
                  this._error(`[${idx + 1}] DB insert failed: ${err.message}`);
                }
              }
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
    lines.push(`LISTING #${idx}  —  ${listing.business_name ?? '(no title)'}`);
    lines.push(DIVIDER);

    const FIELDS = [
      ['Source',       'source'],
      ['URL',          'url'],
      ['Location',     'location'],
      ['Region',       'region'],
      ['Asking Price', 'asking_price'],
      ['Leasehold',    'leasehold'],
      ['Freehold',     'freehold'],
      ['Turnover',     'turnover'],
      ['Net Profit',   'net_profit'],
      ['EBIT',         'ebit'],
      ['EBITDA',       'ebitda'],
      ['Rent',         'rent'],
      ['Sector',       'sector'],
      ['Sub-sector',   'sub_sector'],
      ['Investment',   'investment'],
      ['Franchise Fee','franchise_fee'],
      ['Image',        'image'],
    ];

    for (const [label, key] of FIELDS) {
      const val = listing[key];
      if (val) {
        lines.push(`${label.padEnd(15)}: ${val}`);
      }
    }

    if (listing.description) {
      lines.push(`${'Description'.padEnd(15)}: ${listing.description}`);
    }

    lines.push(DIVIDER);

    console.log(lines.join('\n'));
  }
}
