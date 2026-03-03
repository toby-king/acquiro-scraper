# Acquiro Scraper — Developer Guide

## What this is

Backend scraping service for the Acquiro M&A advisory platform. Aggregates
UK business-for-sale listings from multiple sites into structured data.

Current sources: **Rightbiz.co.uk**
Planned: BusinessesForSale.com, Daltons, Dealsuite (authenticated)

---

## Running the scraper

```bash
node src/index.js
```

Scrapes 3 pages of new UK business listings from Rightbiz and prints each
listing to the console. No database or API server — output goes to stdout.

---

## Project structure

```
src/
  index.js                Entry point — instantiates scraper(s) and runs them.

  scrapers/
    base.js               BaseScraper abstract class.
                          Owns: browser lifecycle, concurrency semaphore,
                          rate-limiting, retry logic, human scroll, output.
    rightbiz.js           RightbizScraper — extends BaseScraper.
                          Owns: Rightbiz-specific selectors and pagination.

  utils/
    browser.js            Stealth Playwright helpers.
                          launchBrowser()  — creates a chromium-extra instance.
                          createContext()  — fresh isolated context per request
                                            (rotated UA, 1920×1080, en-GB).
                          humanScroll()    — scrolls a page to trigger lazy-load.
    rateLimiter.js        Per-domain rate limiting (2–5 s with jitter).
                          rateLimit(url)   — call before every outbound request.
```

---

## How to add a new scraper

### 1. Create `src/scrapers/<sitename>.js`

```js
import * as cheerio from 'cheerio';
import { BaseScraper } from './base.js';

export class MyScraper extends BaseScraper {
  constructor() {
    super({
      name: 'MySite',
      startUrl: 'https://example.com/businesses-for-sale',
      maxConcurrency: 2,   // optional, defaults to 2
    });
  }

  /**
   * Return absolute URLs of individual listing pages for the given page number.
   * Called by BaseScraper.scrape() for pages 1 through maxPages.
   */
  async getListingUrlsForPage(pageNum) {
    // Page 1 — use Playwright (via this._fetchPage)
    if (pageNum === 1) {
      const html = await this._fetchPage(this.startUrl);
      return this._parseUrls(html);
    }

    // Pages 2+ — implement your pagination strategy
    // Option A: URL parameter pagination
    const url = `https://example.com/businesses-for-sale?page=${pageNum}`;
    const html = await this._fetchPage(url);
    return this._parseUrls(html);

    // Option B: POST/GET API endpoint (no browser needed)
    // const res = await fetch(`https://example.com/api/listings?page=${pageNum}`);
    // const json = await res.json();
    // return this._parseUrls(json.html);
  }

  _parseUrls(html) {
    const $ = cheerio.load(html);
    const urls = [];
    $('a.listing-link').each((_, el) => {
      const href = $(el).attr('href');
      if (href) urls.push(new URL(href, 'https://example.com').href);
    });
    return urls;
  }

  /**
   * Extract structured data from a single listing page's HTML.
   * Return null if the page cannot be parsed (404, blocked, etc.).
   */
  extractDetails(html, url) {
    const $ = cheerio.load(html);
    const title = $('h1.title').text().trim();
    if (!title) return null;

    return {
      title,
      url,
      location: $('span.location').text().trim() || null,
      tenure: null,
      price: null,
      turnover: null,
      netProfit: null,
      rent: null,
      sector: null,
      description: $('div.description').text().trim() || null,
    };
  }
}
```

### 2. Register it in `src/index.js`

```js
import { MyScraper } from './scrapers/mysite.js';

const scraper = new MyScraper();
await scraper.scrape(3);
```

---

## Architecture decisions

| Decision | Rationale |
|---|---|
| `playwright-extra` + stealth plugin | Patches `navigator.webdriver`, `chrome.runtime`, WebGL, plugins — the most commonly checked fingerprint vectors. |
| Fresh context per request | Prevents cookies / storage leaking between sites. |
| Rate limit 2–5 s with jitter | Non-deterministic timing defeats statistical bot detection. |
| Semaphore (max 2) | Limits simultaneous open browser contexts; reduces memory and avoids IP rate-bans from burst traffic. |
| Exponential back-off (2 s, 4 s, 8 s + jitter) | Transient failures (timeouts, 429s) are retried gracefully. |
| Cheerio for parsing | Fast, CSS-selector-based; more readable and reliable than regex. |
| `fetch()` for Rightbiz pagination API | The `/search/load_more.php` endpoint requires no cookies and is much faster than a full browser page load. |

---

## Rightbiz selectors reference

### Search results page

| Data | Selector |
|---|---|
| Listing card container | `li.content__body__item.shadow.listing` |
| Title / URL | `a.link-title[href]` |

### Listing detail page

| Data | Selector |
|---|---|
| Title | `h1.content__body__title` |
| Location | `span.location-item` (first) |
| Price / turnover / profit | `ul.content__body__data > li` |
| Description | `div.content__body__description > p` |
| Sector tags | `div#business-tag a[title*="for Sale in UK"]` |

### Pagination API

```
GET /search/load_more.php
  ?sortby=new
  &category=Businesses
  &location=uk
  &page=<N>
  &cat_id=2000
  &more_category=none
  …
```

Response: `{ status, total, nextpage, data: "<html fragment>" }`
The `data` field contains the same listing-card markup as the initial page.
