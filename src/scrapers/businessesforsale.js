/**
 * BusinessesForSaleScraper — scrapes listings from uk.businessesforsale.com.
 *
 * Pagination strategy:
 *   Page 1  → https://uk.businessesforsale.com/uk/search/businesses-for-sale
 *   Page N  → https://uk.businessesforsale.com/uk/search/businesses-for-sale-N
 *   (Server-rendered; no JS needed for search pages.)
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
 *     Description  #main-listing-content p  (first block of paragraphs)
 */

import * as cheerio from 'cheerio';
import { BaseScraper } from './base.js';
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
  }

  // ── Pagination ──────────────────────────────────────────────────────────────

  async getListingUrlsForPage(pageNum) {
    const url =
      pageNum === 1
        ? SEARCH_PAGE_1
        : `${SEARCH_PAGE_1}-${pageNum}`;

    return this._fetchSearchPage(url);
  }

  async _fetchSearchPage(url) {
    await rateLimit(url);

    return this._withRetry(async () => {
      const res = await fetch(url, {
        headers: {
          'User-Agent': this._getRandomDesktopUA(),
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-GB,en;q=0.9',
          Referer: BASE_URL,
        },
      });

      if (res.status === 404) return [];
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const html = await res.text();
      return this._extractUrlsFromHtml(html);
    });
  }

  // ── HTML parsing helpers ────────────────────────────────────────────────────

  _extractUrlsFromHtml(html) {
    const $ = cheerio.load(html);
    const urls = new Set();

    $('div.result table.result-table caption h2 a[href]').each((_, el) => {
      const href = $(el).attr('href')?.trim();
      if (!href) return;
      // Skip franchise opportunities — they follow a different layout
      if (href.includes('/franchises/')) return;
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
   * Description is assembled from the first block of paragraphs in the listing content.
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
      // div#address contains span elements for city, county, country.
      const locationParts = [];
      $('div#address span').each((_, el) => {
        const text = $(el).text().replace(/\s+/g, ' ').trim();
        if (text && text.toLowerCase() !== 'uk') locationParts.push(text);
      });
      const location = locationParts.join(', ') || null;

      // ── Financial fields ───────────────────────────────────────────────────
      const price    = $('dl.price dd strong').first().text().replace(/\s+/g, ' ').trim() || null;
      const turnover = $('dl#revenue dd strong').first().text().replace(/\s+/g, ' ').trim() || null;
      const netProfit = $('dl#profit dd strong').first().text().replace(/\s+/g, ' ').trim() || null;

      // ── Tenure and other structured details ────────────────────────────────
      let tenure = null;
      $('dl.listing-details').each((_, el) => {
        const dt = $(el).find('dt').text().trim().toLowerCase();
        const dd = $(el).find('dd').text().replace(/\s+/g, ' ').trim();
        if (dt.includes('tenure') && dd) tenure = dd;
      });

      // ── Description ───────────────────────────────────────────────────────
      // The main listing content lives in #main-listing-content; we collect
      // all <p> text from there, skipping nav/sidebar boilerplate.
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
        sector: null,  // BFS category pages require additional navigation
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
