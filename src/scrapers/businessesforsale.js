/**
 * BusinessesForSaleScraper — scrapes listings from uk.businessesforsale.com.
 *
 * Pagination strategy:
 *   Page 1  → https://uk.businessesforsale.com/uk/search/businesses-for-sale
 *   Page N  → https://uk.businessesforsale.com/uk/search/businesses-for-sale-N
 *
 * Anti-bot strategy:
 *   BFS is protected by Cloudflare, which binds the cf_clearance cookie to the
 *   client's TLS fingerprint (JA3/JA4). Reusing the cookie in Node.js fetch()
 *   fails because fetch() uses a different TLS stack than Chromium.
 *
 *   Solution: a single persistent Playwright context is created for the entire
 *   scrape session. The first page load lets Cloudflare verify the browser;
 *   all subsequent requests (search pages 2+ and every detail page) reuse the
 *   same context so the session cookies and TLS fingerprint stay consistent.
 *
 * Selectors confirmed against live HTML on 2026-03-03:
 *
 *   Search results card:
 *     Container   div.result
 *     Title link  table.result-table caption h2 a[href]
 *     (Franchise listings under /uk/franchises/ are skipped.)
 *
 *   Listing detail page:
 *     Title        h1  (first)
 *     Location     div#address span  (joined; "UK" excluded)
 *     Price        dl.price dd strong
 *     Turnover     dl#revenue dd strong
 *     Net Profit   dl#profit dd strong
 *     Details      dl.listing-details  (dt → key, dd → value; tenure if present)
 *     Description  #main-listing-content p
 */

import * as cheerio from 'cheerio';
import { BaseScraper } from './base.js';
import { createContext, humanScroll } from '../utils/browser.js';
import { rateLimit } from '../utils/rateLimiter.js';

const BASE_URL = 'https://uk.businessesforsale.com';
const SEARCH_PAGE_1 = `${BASE_URL}/uk/search/businesses-for-sale`;

export class BusinessesForSaleScraper extends BaseScraper {
  constructor() {
    super({
      name: 'BusinessesForSale',
      startUrl: SEARCH_PAGE_1,
      maxConcurrency: 2,
    });
    this._sharedContext = null;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  async _init() {
    await super._init();
    // One persistent context for the whole session — Cloudflare cookies and
    // TLS fingerprint stay consistent across all BFS requests.
    this._sharedContext = await createContext(this._browser);
    this._log('Shared browser context created.');
  }

  async _teardown() {
    if (this._sharedContext) {
      await this._sharedContext.close().catch(() => {});
      this._sharedContext = null;
    }
    await super._teardown();
  }

  // ── Shared-context page fetch ───────────────────────────────────────────────

  /**
   * Load `url` in the shared Playwright context (opens a new tab, then closes it).
   * All BFS requests go through this so Cloudflare sees a consistent session.
   */
  async _fetchWithSharedContext(url) {
    await rateLimit(url);

    return this._withRetry(async () => {
      const page = await this._sharedContext.newPage();
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await humanScroll(page);
        return await page.content();
      } finally {
        await page.close();
      }
    });
  }

  // ── Pagination ──────────────────────────────────────────────────────────────

  async getListingUrlsForPage(pageNum) {
    const url =
      pageNum === 1
        ? SEARCH_PAGE_1
        : `${SEARCH_PAGE_1}-${pageNum}`;

    const html = await this._fetchWithSharedContext(url);
    return this._extractUrlsFromHtml(html);
  }

  // ── Detail page fetch ───────────────────────────────────────────────────────

  async _fetchDetailPage(url) {
    return this._fetchWithSharedContext(url);
  }

  // ── HTML parsing helpers ────────────────────────────────────────────────────

  _extractUrlsFromHtml(html) {
    const $ = cheerio.load(html);
    const urls = new Set();

    $('div.result table.result-table caption h2 a[href]').each((_, el) => {
      const href = $(el).attr('href')?.trim();
      if (!href) return;
      if (href.includes('/franchises/')) return;
      const abs = href.startsWith('http') ? href : `${BASE_URL}${href}`;
      urls.add(abs);
    });

    return [...urls];
  }

  extractDetails(html, url) {
    try {
      const $ = cheerio.load(html);

      // ── Title ──────────────────────────────────────────────────────────────
      const title = $('h1').first().text().replace(/\s+/g, ' ').trim();

      if (!title) {
        this._log(`Skipping ${url} — no title found (may be blocked or 404)`);
        return null;
      }

      // ── Location ───────────────────────────────────────────────────────────
      const locationParts = [];
      $('div#address span').each((_, el) => {
        const text = $(el).text().replace(/\s+/g, ' ').trim();
        if (text && text.toLowerCase() !== 'uk') locationParts.push(text);
      });
      const location = locationParts.join(', ') || null;

      // ── Financial fields ───────────────────────────────────────────────────
      const price     = $('dl.price dd strong').first().text().replace(/\s+/g, ' ').trim() || null;
      const turnover  = $('dl#revenue dd strong').first().text().replace(/\s+/g, ' ').trim() || null;
      const netProfit = $('dl#profit dd strong').first().text().replace(/\s+/g, ' ').trim() || null;

      // ── Tenure ────────────────────────────────────────────────────────────
      let tenure = null;
      $('dl.listing-details').each((_, el) => {
        const dt = $(el).find('dt').text().trim().toLowerCase();
        const dd = $(el).find('dd').text().replace(/\s+/g, ' ').trim();
        if (dt.includes('tenure') && dd) tenure = dd;
      });

      // ── Description ───────────────────────────────────────────────────────
      const descParts = [];
      $('#main-listing-content p').each((_, el) => {
        const text = $(el).text().replace(/\s+/g, ' ').trim();
        if (text) descParts.push(text);
      });
      const description = descParts.join('\n\n') || null;

      return {
        title,
        url,
        location,
        tenure,
        price,
        turnover,
        netProfit,
        rent: null,
        sector: null,
        description,
      };
    } catch (err) {
      this._error(`extractDetails failed for ${url}: ${err.message}`);
      return null;
    }
  }
}
