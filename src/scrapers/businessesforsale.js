/**
 * BusinessesForSaleScraper — scrapes listings from uk.businessesforsale.com.
 *
 * Pagination strategy:
 *   Page 1  → https://uk.businessesforsale.com/uk/search/businesses-for-sale
 *   Page N  → https://uk.businessesforsale.com/uk/search/businesses-for-sale-N
 *
 * Anti-bot strategy:
 *   BFS is protected by Cloudflare. Page 1 is loaded via Playwright (stealth)
 *   to solve the challenge and capture the resulting cookies (cf_clearance etc.).
 *   All subsequent requests (search pages 2+ and every detail page) reuse those
 *   cookies via plain fetch(), which is much faster and avoids headless detection
 *   on individual listing pages.
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
 *     Details      dl.listing-details  (dt → key, dd → value; tenure extracted if present)
 *     Description  #main-listing-content p
 */

import * as cheerio from 'cheerio';
import { BaseScraper } from './base.js';
import { createContext, humanScroll } from '../utils/browser.js';
import { rateLimit, randomInt } from '../utils/rateLimiter.js';

const BASE_URL = 'https://uk.businessesforsale.com';
const SEARCH_PAGE_1 = `${BASE_URL}/uk/search/businesses-for-sale`;

export class BusinessesForSaleScraper extends BaseScraper {
  constructor() {
    super({
      name: 'BusinessesForSale',
      startUrl: SEARCH_PAGE_1,
      maxConcurrency: 2,
    });
    this._sessionCookies = null; // populated after first Playwright load
  }

  // ── Pagination ──────────────────────────────────────────────────────────────

  async getListingUrlsForPage(pageNum) {
    const url =
      pageNum === 1
        ? SEARCH_PAGE_1
        : `${SEARCH_PAGE_1}-${pageNum}`;

    // Page 1: use Playwright to solve the Cloudflare challenge and capture cookies.
    if (pageNum === 1) return this._fetchSearchPageWithPlaywright(url);

    // Pages 2+: reuse the captured session cookies via fast fetch().
    return this._fetchSearchPage(url);
  }

  // ── Playwright-based first load (cookie capture) ────────────────────────────

  async _fetchSearchPageWithPlaywright(url) {
    await rateLimit(url);

    return this._withRetry(async () => {
      const context = await createContext(this._browser);
      const page = await context.newPage();

      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await humanScroll(page);

        // Capture all cookies (including cf_clearance) for reuse.
        this._sessionCookies = await context.cookies();
        this._log(`Session established — ${this._sessionCookies.length} cookie(s) captured.`);

        const html = await page.content();
        return this._extractUrlsFromHtml(html);
      } finally {
        await context.close();
      }
    });
  }

  // ── Cookie helper ───────────────────────────────────────────────────────────

  _cookieHeader() {
    if (!this._sessionCookies || this._sessionCookies.length === 0) return '';
    return this._sessionCookies.map((c) => `${c.name}=${c.value}`).join('; ');
  }

  _fetchHeaders(referer = BASE_URL) {
    return {
      'User-Agent': this._getRandomDesktopUA(),
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-GB,en;q=0.9',
      Referer: referer,
      Cookie: this._cookieHeader(),
    };
  }

  // ── fetch()-based search pages (pages 2+) ───────────────────────────────────

  async _fetchSearchPage(url) {
    await rateLimit(url);

    return this._withRetry(async () => {
      const res = await fetch(url, { headers: this._fetchHeaders() });

      if (res.status === 404) return [];
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const html = await res.text();
      return this._extractUrlsFromHtml(html);
    });
  }

  // ── Detail page fetch (fetch() + session cookies) ───────────────────────────

  /**
   * All detail pages use fetch() with the Cloudflare session cookies captured
   * during the page-1 Playwright load. This avoids headless-browser detection
   * on individual listing pages while still passing Cloudflare's cookie check.
   */
  async _fetchDetailPage(url) {
    await rateLimit(url);

    return this._withRetry(async () => {
      const res = await fetch(url, { headers: this._fetchHeaders(SEARCH_PAGE_1) });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    });
  }

  // ── HTML parsing helpers ────────────────────────────────────────────────────

  _extractUrlsFromHtml(html) {
    const $ = cheerio.load(html);
    const urls = new Set();

    $('div.result table.result-table caption h2 a[href]').each((_, el) => {
      const href = $(el).attr('href')?.trim();
      if (!href) return;
      if (href.includes('/franchises/')) return; // skip franchise listings
      const abs = href.startsWith('http') ? href : `${BASE_URL}${href}`;
      urls.add(abs);
    });

    return [...urls];
  }

  /**
   * Parse a listing detail page.
   *
   * Financial fields (price, turnover, net profit) are in dedicated <dl> elements.
   * Tenure is extracted from dl.listing-details if present.
   * Description is assembled from paragraphs in the main listing content area.
   */
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

  // ── Utility ─────────────────────────────────────────────────────────────────

  _getRandomDesktopUA() {
    const uas = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
    ];
    return uas[randomInt(0, uas.length - 1)];
  }
}
