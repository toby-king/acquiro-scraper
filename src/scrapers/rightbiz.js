/**
 * RightbizScraper — scrapes business listings from Rightbiz.co.uk.
 *
 * Pagination strategy:
 *   Page 1  → full Playwright browser load of the search results page.
 *   Page 2+ → GET request to /search/load_more.php (JSON API; no cookie needed).
 *             The `data` field in the response contains rendered HTML fragments
 *             with the same listing-card markup as the initial page.
 *
 * Selectors confirmed against live HTML on 2025-03-02:
 *
 *   Search results card:
 *     Container   li.content__body__item.shadow.listing
 *     Title link  a.link-title[href]
 *
 *   Listing detail page:
 *     Title        h1.content__body__title
 *     Location     span.location-item  (first occurrence)
 *     Key data     ul.content__body__data > li  (price / turnover / profit)
 *     Description  div.content__body__description > p
 *     Categories   div#business-tag a[title*="for Sale in UK"]
 */

import * as cheerio from 'cheerio';
import { BaseScraper } from './base.js';
import { rateLimit, randomInt } from '../utils/rateLimiter.js';
import { getFormattedListingId } from '../utils/listingId.js';

const BASE_URL = 'https://www.rightbiz.co.uk';

const LOAD_MORE_PARAMS = new URLSearchParams({
  sortby: 'new',
  category: 'Businesses',
  location: 'uk',
  textquery: '',
  lat: '',
  lon: '',
  stripped_name: 'UK',
  radius: '',
  more_category: 'none',
  cat_id: '2000',
  tenure: '',
});

export class RightbizScraper extends BaseScraper {
  constructor() {
    super({
      name: 'Rightbiz',
      startUrl:
        'https://www.rightbiz.co.uk/search/?more_category=none&sector=businesses&location=uk&more_category=none&sortby=new&noindex=1',
      maxConcurrency: 2,
    });
  }

  // ── Pagination ─────────────────────────────────────────────────────────────

  /**
   * Page 1: load with Playwright (handles Cloudflare, JS, cookies).
   * Pages 2+: hit the load_more.php JSON API directly (no browser needed).
   * @param {number} pageNum
   * @returns {Promise<string[]>}  Absolute URLs of listing detail pages.
   */
  async getListingUrlsForPage(pageNum) {
    if (pageNum === 1) {
      const html = await this._fetchPage(this.startUrl);
      return this._extractUrlsFromHtml(html);
    }

    return this._fetchLoadMorePage(pageNum);
  }

  /**
   * Call the load_more.php JSON endpoint to get listing HTML for a given page.
   * @param {number} pageNum
   * @returns {Promise<string[]>}
   */
  async _fetchLoadMorePage(pageNum) {
    const params = new URLSearchParams(LOAD_MORE_PARAMS);
    params.set('page', String(pageNum));

    const url = `${BASE_URL}/search/load_more.php?${params.toString()}`;

    await rateLimit(url);

    return this._withRetry(async () => {
      const ua = this._getRandomDesktopUA();
      const res = await fetch(url, {
        headers: {
          'User-Agent': ua,
          Accept: 'application/json, text/javascript, */*; q=0.01',
          'Accept-Language': 'en-GB,en;q=0.9',
          Referer: this.startUrl,
          'X-Requested-With': 'XMLHttpRequest',
        },
      });

      if (!res.ok) {
        throw new Error(`load_more.php returned HTTP ${res.status}`);
      }

      const json = await res.json();

      if (json.status !== 'success' || !json.data) {
        this._log(`load_more.php page ${pageNum}: no data (nextpage=${json.nextpage ?? '?'})`);
        return [];
      }

      const urls = this._extractUrlsFromHtml(json.data);
      return urls;
    });
  }

  // ── HTML parsing helpers ───────────────────────────────────────────────────

  /**
   * Extract all listing-detail page URLs from search-results HTML (or API fragment).
   * Selector: li.content__body__item a.link-title[href]
   * @param {string} html
   * @returns {string[]}  Absolute URLs.
   */
  _extractUrlsFromHtml(html) {
    const $ = cheerio.load(html);
    const urls = new Set();

    $('li.content__body__item a.link-title[href]').each((_, el) => {
      const href = $(el).attr('href')?.trim();
      if (href && href.startsWith('/buy_business/')) {
        urls.add(`${BASE_URL}${href}`);
      }
    });

    return [...urls];
  }

  /**
   * Parse a listing detail page and return a structured object.
   *
   * Available structured fields (from actual HTML):
   *   title, location, price, tenure, turnover, netProfit,
   *   sector, description, url
   *
   * Fields like year_established, employees, reason_for_sale are embedded in
   * free-text descriptions on Rightbiz and are not reliably machine-readable.
   *
   * @param {string} html
   * @param {string} url
   * @returns {object | null}
   */
  extractDetails(html, url) {
    try {
      const $ = cheerio.load(html);

      // ── Title ───────────────────────────────────────────────────────────
      const title = $('h1.content__body__title').first().text().trim()
        || $('h1#headline').first().text().trim();

      if (!title) {
        this._log(`Skipping ${url} — could not find title (may be blocked or 404)`);
        return null;
      }

      const listing_id = getFormattedListingId(url, $);

      // ── Location + Region ─────────────────────────────────────────────────
      // The page has multiple .location-item elements; the first one in the
      // main content area is the listing's location.
      // Format is typically "Town, County" — split to get location + region.
      const rawLocation = $('span.location-item').first().text().trim().replace(/\s+/g, ' ');
      let location = rawLocation || null;
      let region = null;
      if (rawLocation.includes(', ')) {
        const parts = rawLocation.split(', ');
        location = parts[0];
        region = parts[1];
      }

      // ── Key financial data ────────────────────────────────────────────────
      // ul.content__body__data > li holds rows like:
      //   "Leasehold: Price on Application"
      //   "Turnover: £345,000 (£6,635 per week)"
      //   "Profit: On request"
      const dataItems = {};
      $('ul.content__body__data > li').each((_, el) => {
        const raw = $(el).text().replace(/\s+/g, ' ').trim();
        const colonIdx = raw.indexOf(':');
        if (colonIdx === -1) return;
        const key = raw.slice(0, colonIdx).trim().toLowerCase();
        const value = raw.slice(colonIdx + 1).trim();
        dataItems[key] = value;
      });

      const tenure = 'leasehold' in dataItems
        ? 'Leasehold'
        : 'freehold' in dataItems
          ? 'Freehold'
          : null;

      const price = dataItems['leasehold'] ?? dataItems['freehold'] ?? null;
      const turnover = dataItems['turnover'] ?? null;
      const netProfit = dataItems['profit'] ?? null;
      const rent = dataItems['rent'] ?? null;

      // ── Sector / categories ───────────────────────────────────────────────
      // div#business-tag contains tags like:
      //   "Takeaways For Sale in UK"
      //   "Businesses For Sale in Spalding"
      //   "Dessert & Ice Cream Businesses For Sale in UK"
      // We only want the UK-level tags and strip the "For Sale in UK" suffix.
      const sectorSet = new Set();
      $('div#business-tag a, div.business-tag-wrapper a').each((_, el) => {
        const titleAttr = ($(el).attr('title') ?? '').trim();
        if (titleAttr.includes('for Sale in UK')) {
          const cat = titleAttr.replace(/ for Sale in UK$/i, '').trim();
          // Skip the completely generic "Businesses" entry
          if (cat && cat.toLowerCase() !== 'businesses') {
            sectorSet.add(cat);
          }
        }
      });
      const sector = sectorSet.size > 0 ? [...sectorSet].join(', ') : null;

      // ── Description ───────────────────────────────────────────────────────
      // Grab the whole container (h2 heading + all paragraphs) in one pass.
      const description =
        $('div.content__body__description').text().replace(/\s+/g, ' ').trim() || null;

      // ── Image ─────────────────────────────────────────────────────────────
      const image =
        $('.content__body__img-list img').first().attr('src') ||
        $('.content-body-img-slider-wrapper img').first().attr('src') ||
        null;

      const result = { listing_id, business_name: title, url };
      if (location)                        result.location    = location;
      if (region)                          result.region      = region;
      if (image)                           result.image       = image;
      if (price)                           result.asking_price = price;
      if (tenure === 'Leasehold' && price) result.leasehold   = price;
      if (tenure === 'Freehold'  && price) result.freehold    = price;
      if (turnover)                        result.turnover    = turnover;
      if (netProfit)                       result.net_profit  = netProfit;
      if (rent)                            result.rent        = rent;
      if (sector)                          result.sector      = sector;
      if (description)                     result.description = description;

      this._applyTextFinancials(result);
      return result;
    } catch (err) {
      this._error(`extractDetails failed for ${url}: ${err.message}`);
      return null;
    }
  }

  // ── Utility ────────────────────────────────────────────────────────────────

  /**
   * Return a random desktop UA string for API fetch() calls.
   * Keeps API requests looking browser-like.
   * @returns {string}
   */
  _getRandomDesktopUA() {
    const uas = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15',
    ];
    return uas[randomInt(0, uas.length - 1)];
  }
}
