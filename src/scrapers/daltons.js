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

    const html = await this._fetchPage(url);
    return this._extractUrlsFromHtml(html);
  }

  // ── HTML parsing helpers ────────────────────────────────────────────────────

  _extractUrlsFromHtml(html) {
    const $ = cheerio.load(html);
    const urls = new Set();

    $('div.item-listing-wrap h3.item-title a[href]').each((_, el) => {
      const href = $(el).attr('href')?.trim();
      if (!href) return;
      const abs = href.startsWith('http') ? href : `${BASE_URL}${href}`;
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

      // ── Location + Region ─────────────────────────────────────────────────
      // address.item-address can repeat the same item — deduplicate while
      // preserving order (e.g. ["West Sussex", "England"]).
      const seenLocItems = new Set();
      const locationItems = [];
      $('address.item-address a').each((_, el) => {
        const text = $(el).text().trim();
        if (text && !seenLocItems.has(text)) {
          seenLocItems.add(text);
          locationItems.push(text);
        }
      });
      const location = locationItems[0] || null;
      const region   = locationItems.length > 1 ? locationItems[locationItems.length - 1] : null;

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

      // ── Annual financials ─────────────────────────────────────────────────
      // Each li.item-annual-price is one row: "Annual Turnover: £45,392"
      // There may be multiple rows (turnover, net profit, possibly multiple years).
      // Iterate and pick the first match per field by keyword.
      let turnover  = null;
      let netProfit = null;
      $('ul.item-price-wrap li.item-annual-price').each((_, el) => {
        const raw = $(el).text().replace(/\s+/g, ' ').trim();
        const colonIdx = raw.indexOf(':');
        if (colonIdx === -1) return;
        const key   = raw.slice(0, colonIdx).trim().toLowerCase();
        const value = raw.slice(colonIdx + 1).trim() || null;
        if (!turnover  && /turnover/i.test(key))    turnover  = value;
        if (!netProfit && /net\s*profit/i.test(key)) netProfit = value;
      });

      // ── Sector ────────────────────────────────────────────────────────────
      const sectorSet = new Set();
      $('div.property-overview-wrap li.property-overview-item a').each((_, el) => {
        const text = $(el).text().trim();
        if (text) sectorSet.add(text);
      });
      const sector = sectorSet.size > 0 ? [...sectorSet].join(', ') : null;

      // ── Description ───────────────────────────────────────────────────────
      // Use the full description wrapper (covers both #viewMoreContent blocks).
      const description =
        $('#property-description-wrap').text().replace(/\s+/g, ' ').trim() || null;

      // ── Image ─────────────────────────────────────────────────────────────
      const image =
        $('div.property-top-wrap img.img-fluid').first().attr('src') || null;

      const result = { business_name: title, url };
      if (location)                        result.location     = location;
      if (region)                          result.region       = region;
      if (image)                           result.image        = image;
      if (price)                           result.asking_price = price;
      if (tenure === 'Leasehold' && price) result.leasehold    = price;
      if (tenure === 'Freehold'  && price) result.freehold     = price;
      if (turnover)                        result.turnover     = turnover;
      if (netProfit)                       result.net_profit   = netProfit;
      if (sector)                          result.sector       = sector;
      if (description)                     result.description  = description;

      this._applyTextFinancials(result);
      return result;
    } catch (err) {
      this._error(`extractDetails failed for ${url}: ${err.message}`);
      return null;
    }
  }

}
