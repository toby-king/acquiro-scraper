/**
 * DaltonsScraper — scrapes business listings from daltonsbusiness.com.
 *
 * Pagination strategy:
 *   All pages → GET with ?page=N query parameter (server-rendered; no JS needed).
 *
 * Selectors confirmed against live HTML on 2026-03-03:
 *
 *   Search results card:
 *     Container   div.item-listing-wrap
 *     Title link  h3.item-title > a[href]
 *
 *   Listing detail page:
 *     Title        h1  (first)
 *     Location     address.item-address a  (deduplicated)
 *     Price/Tenure ul.item-price-wrap > li  (text parsed as "Key: Value")
 *     Sector       div.property-overview-wrap li.property-overview-item a
 *     Description  div#viewMoreContent p
 */

import * as cheerio from 'cheerio';
import { BaseScraper } from './base.js';
import { rateLimit, randomInt } from '../utils/rateLimiter.js';

const BASE_URL = 'https://www.daltonsbusiness.com';
const SEARCH_BASE =
  `${BASE_URL}/listing-businesses-for-sale/?sortby=d_date&flt=1`;

export class DaltonsScraper extends BaseScraper {
  constructor() {
    super({
      name: 'Daltons',
      startUrl: SEARCH_BASE,
      maxConcurrency: 2,
    });
  }

  // ── Pagination ──────────────────────────────────────────────────────────────

  async getListingUrlsForPage(pageNum) {
    const url =
      pageNum === 1
        ? SEARCH_BASE
        : `${SEARCH_BASE}&page=${pageNum}`;

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

    $('div.item-listing-wrap h3.item-title a[href]').each((_, el) => {
      const href = $(el).attr('href')?.trim();
      if (!href) return;
      const abs = href.startsWith('http') ? href : `${BASE_URL}${href}`;
      // Only include individual listing pages (not category/search pages)
      if (abs.includes('/listing/')) urls.add(abs);
    });

    return [...urls];
  }

  /**
   * Parse a listing detail page.
   *
   * Price and tenure are extracted from ul.item-price-wrap list items.
   * Text format is typically "Key: Value" or just "Value" for some variants.
   * Sector comes from the property overview section's category links.
   * Turnover and net profit are not in structured fields on Daltons —
   * they appear in the description text.
   */
  extractDetails(html, url) {
    try {
      const $ = cheerio.load(html);

      // ── Title ──────────────────────────────────────────────────────────────
      const title = $('h1').first().text().trim();

      if (!title) {
        this._log(`Skipping ${url} — no title found (may be blocked or 404)`);
        return null;
      }

      // ── Location ───────────────────────────────────────────────────────────
      // address.item-address can repeat the same region — deduplicate.
      const locationParts = new Set();
      $('address.item-address a').each((_, el) => {
        const text = $(el).text().trim();
        if (text) locationParts.add(text);
      });
      const location = [...locationParts].join(', ') || null;

      // ── Price and Tenure ───────────────────────────────────────────────────
      // List items may look like:
      //   "Price: £49,995"       → price
      //   "Leasehold Price: £…"  → price + tenure = Leasehold
      //   "Freehold: £…"         → price + tenure = Freehold
      //   "Leasehold: £…"        → same
      let price = null;
      let tenure = null;

      $('ul.item-price-wrap li').each((_, el) => {
        const raw = $(el).text().replace(/\s+/g, ' ').trim();
        const colonIdx = raw.indexOf(':');
        if (colonIdx === -1) return;

        const key = raw.slice(0, colonIdx).trim().toLowerCase();
        const value = raw.slice(colonIdx + 1).trim();

        if (!price && key === 'price') price = value;

        if (/leasehold|leashold/.test(key)) {
          tenure = tenure ?? 'Leasehold';
          price = price ?? value;
        } else if (/freehold/.test(key)) {
          tenure = tenure ?? 'Freehold';
          price = price ?? value;
        }
      });

      // ── Sector ────────────────────────────────────────────────────────────
      const sectorSet = new Set();
      $('div.property-overview-wrap li.property-overview-item a').each((_, el) => {
        const text = $(el).text().trim();
        if (text) sectorSet.add(text);
      });
      const sector = sectorSet.size > 0 ? [...sectorSet].join(', ') : null;

      // ── Description ───────────────────────────────────────────────────────
      const descParts = [];
      $('div#viewMoreContent p').each((_, el) => {
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
        turnover: null,  // embedded in description text on Daltons
        netProfit: null,
        rent: null,
        sector,
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
