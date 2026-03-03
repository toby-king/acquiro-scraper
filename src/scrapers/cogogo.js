/**
 * CoGoGoScraper — scrapes business listings from letscogogo.com.
 *
 * Pagination strategy:
 *   All pages → GET the WordPress paginated URL directly (no JS needed).
 *
 * Selectors confirmed against live HTML on 2026-03-03:
 *
 *   Search results card:
 *     Container   div.search-resultBlock
 *     Link        div.business-link a[href]
 *
 *   Listing detail page:
 *     Title        h1 (first)
 *     Location     p.property-location
 *     Key details  ul.key-details > li.key-detail  (unlabelled; inferred from content)
 *     Description  div.tab-pane#overview div.row
 */

import * as cheerio from 'cheerio';
import { BaseScraper } from './base.js';
import { rateLimit, randomInt } from '../utils/rateLimiter.js';

const BASE_URL = 'https://letscogogo.com';

export class CoGoGoScraper extends BaseScraper {
  constructor() {
    super({
      name: 'CoGoGo',
      startUrl: 'https://letscogogo.com/businesses-for-sale/',
      maxConcurrency: 2,
    });
  }

  // ── Pagination ──────────────────────────────────────────────────────────────

  async getListingUrlsForPage(pageNum) {
    const url =
      pageNum === 1
        ? this.startUrl
        : `${BASE_URL}/businesses-for-sale/page/${pageNum}/`;

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
        },
      });

      if (res.status === 404) return [];          // past the last page
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const html = await res.text();
      return this._extractUrlsFromHtml(html);
    });
  }

  // ── HTML parsing helpers ────────────────────────────────────────────────────

  _extractUrlsFromHtml(html) {
    const $ = cheerio.load(html);
    const urls = new Set();

    $('div.search-resultBlock div.business-link a[href]').each((_, el) => {
      const href = $(el).attr('href')?.trim();
      if (href && href.includes('/businesses-for-sale/') && href !== `${BASE_URL}/businesses-for-sale/`) {
        urls.add(href.startsWith('http') ? href : `${BASE_URL}${href}`);
      }
    });

    return [...urls];
  }

  /**
   * Parse a listing detail page.
   *
   * CoGoGo key-details are unlabelled list items; we infer meaning from content:
   *   "£…"                    → asking price
   *   text containing "turnover" (case-insensitive) → turnover
   *   "Leasehold" | "Freehold" | "Business Only"    → tenure
   */
  extractDetails(html, url) {
    try {
      const $ = cheerio.load(html);

      // ── Title ──────────────────────────────────────────────────────────────
      const title =
        $('div.searchdetailsBlock h1').first().text().trim() ||
        $('h1').first().text().trim();

      if (!title) {
        this._log(`Skipping ${url} — no title found (may be blocked or 404)`);
        return null;
      }

      // ── Location ───────────────────────────────────────────────────────────
      const location =
        $('p.property-location').first().text().replace(/\s+/g, ' ').trim() || null;

      // ── Key details (price / turnover / tenure) ────────────────────────────
      let price = null;
      let turnover = null;
      let tenure = null;

      $('ul.key-details li.key-detail').each((_, el) => {
        const item = $(el);

        // Some listings label each item with a descriptor span; others don't.
        const descriptor = item
          .find('span.key-detail__descriptor')
          .text()
          .trim()
          .toLowerCase();

        const rawText = item.text().replace(/\s+/g, ' ').trim();
        const value = descriptor
          ? rawText.replace(new RegExp(descriptor, 'i'), '').trim()
          : rawText;

        if (descriptor) {
          if (descriptor.includes('price')) price = price ?? value;
          else if (descriptor.includes('turnover')) turnover = turnover ?? value;
          else if (descriptor.includes('tenure')) tenure = tenure ?? value;
        } else {
          // Infer from content
          if (/^£[\d,]/.test(rawText)) {
            price = price ?? rawText;
          } else if (/turnover/i.test(rawText)) {
            turnover = turnover ?? rawText;
          } else if (/leasehold|freehold|business only/i.test(rawText)) {
            tenure = tenure ?? rawText;
          }
        }
      });

      // ── Description (overview tab) ─────────────────────────────────────────
      // Replace <br> tags with newlines before extracting text.
      const overviewEl = $('div.tab-pane#overview div.row');
      overviewEl.find('br').replaceWith('\n');
      const description =
        overviewEl.text().replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim() ||
        null;

      return {
        title,
        url,
        location,
        tenure,
        price,
        turnover,
        netProfit: null,
        rent: null,
        sector: null,  // CoGoGo does not expose a structured sector field
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
