/**
 * Listing ID adapters — extract a stable, source-native ID from each site.
 *
 * Each adapter returns a prefixed string, e.g. "rightbiz_123456".
 * Adapters throw on failure so the error propagates through extractDetails()
 * and is caught by base.js's outer try/catch, skipping the listing cleanly.
 */

// BFS — "Listing ID: 123456" in body text
function bfsId(url, $) {
  const m = $('body').text().match(/Listing\s+ID[:\s]+(\d+)/i);
  if (!m) throw new Error(`bfs: Listing ID not found in ${url}`);
  return `bfs_${m[1]}`;
}

// Rightbiz — numeric prefix in URL path e.g. /buy_business/for_sale/645229_name.html
function rightbizId(url, $) {
  const m = url.match(/\/buy_business\/[^/]*\/(\d+)[_-]/);
  if (!m) throw new Error(`rightbiz: numeric ID not found in URL ${url}`);
  return `rightbiz_${m[1]}`;
}

// CoGoGo — trailing digits after last underscore OR hyphen in URL path
// e.g. /businesses-for-sale/roofing-contractors-7433/
function cogogoId(url, $) {
  const m = url.match(/[_-](\d+)\/?$/);
  if (!m) throw new Error(`cogogo: numeric ID not found in URL ${url}`);
  return `cogogo_${m[1]}`;
}

// Daltons — "DB\d+" segment at the end of the URL slug
// e.g. /listing/successful-mobility-store-for-sale-DB2375812
function daltonsId(url, $) {
  const m = url.match(/-(DB\d+)\/?$/i);
  if (!m) throw new Error(`daltons: DB ID not found in URL ${url}`);
  return `daltons_${m[1]}`;
}

const ADAPTERS = {
  'uk.businessesforsale.com': bfsId,
  'www.rightbiz.co.uk':       rightbizId,
  'rightbiz.co.uk':           rightbizId,
  'letscogogo.com':           cogogoId,
  'www.letscogogo.com':       cogogoId,
  'www.daltonsbusiness.com':  daltonsId,
  'daltonsbusiness.com':      daltonsId,
};

/**
 * Extract a formatted, source-prefixed listing ID.
 *
 * @param {string} url   - The listing's canonical URL.
 * @param {import('cheerio').CheerioAPI} $  - Loaded Cheerio instance for the page.
 * @returns {string}     - e.g. "rightbiz_123456"
 * @throws {Error}       - If the ID cannot be found or the domain is unknown.
 */
export function getFormattedListingId(url, $) {
  const { hostname } = new URL(url);
  const adapter = ADAPTERS[hostname];
  if (!adapter) throw new Error(`No listing ID adapter for domain: ${hostname}`);
  return adapter(url, $);
}

// ─── URL-only adapters (no Cheerio needed) ────────────────────────────────────

const URL_ID_ADAPTERS = {
  'www.rightbiz.co.uk':      (url) => { const m = url.match(/\/buy_business\/[^/]*\/(\d+)[_-]/); return m ? `rightbiz_${m[1]}` : null; },
  'rightbiz.co.uk':          (url) => { const m = url.match(/\/buy_business\/[^/]*\/(\d+)[_-]/); return m ? `rightbiz_${m[1]}` : null; },
  'letscogogo.com':          (url) => { const m = url.match(/[_-](\d+)\/?$/);             return m ? `cogogo_${m[1]}`   : null; },
  'www.letscogogo.com':      (url) => { const m = url.match(/[_-](\d+)\/?$/);             return m ? `cogogo_${m[1]}`   : null; },
  'www.daltonsbusiness.com': (url) => { const m = url.match(/-(DB\d+)\/?$/i);             return m ? `daltons_${m[1]}` : null; },
  'daltonsbusiness.com':     (url) => { const m = url.match(/-(DB\d+)\/?$/i);             return m ? `daltons_${m[1]}` : null; },
  // BFS intentionally omitted — listing_id must come from the detail page HTML
};

/**
 * Extract a listing ID from the URL alone (no page fetch or Cheerio needed).
 * Returns null for BFS and any URL where the pattern is not matched.
 *
 * @param {string} url
 * @returns {string | null}  e.g. "rightbiz_123456", or null
 */
export function getListingIdFromUrl(url) {
  try {
    const { hostname } = new URL(url);
    const adapter = URL_ID_ADAPTERS[hostname];
    return adapter ? adapter(url) : null;
  } catch {
    return null;
  }
}
