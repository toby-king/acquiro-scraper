/**
 * Acquiro Scraper — HTTP API server.
 *
 * POST /scrape
 *   Body (JSON): { "sources": "rightbiz", "pages": 3 }
 *            or: { "sources": ["rightbiz", "cogogo"], "pages": 3 }
 *
 *   Response: {
 *     "pages": 3,
 *     "count": 75,
 *     "by_source": { "Rightbiz": 40, "CoGoGo": 35 },
 *     "listings": [...]
 *   }
 *
 * Valid source values: rightbiz, cogogo, daltons, businessesforsale (alias: bfs)
 *
 * Run:
 *   node src/server.js
 *   PORT=8080 node src/server.js
 */

import { createServer } from 'http';
import { RightbizScraper } from './scrapers/rightbiz.js';
import { CoGoGoScraper } from './scrapers/cogogo.js';
import { DaltonsScraper } from './scrapers/daltons.js';
import { BusinessesForSaleScraper } from './scrapers/businessesforsale.js';

const PORT = parseInt(process.env.PORT ?? '3000', 10);

const SCRAPERS = {
  rightbiz:          () => new RightbizScraper(),
  cogogo:            () => new CoGoGoScraper(),
  daltons:           () => new DaltonsScraper(),
  businessesforsale: () => new BusinessesForSaleScraper(),
  bfs:               () => new BusinessesForSaleScraper(),
};

const VALID_SOURCES = Object.keys(SCRAPERS).filter((k) => k !== 'bfs').join(', ');

// ── Helpers ──────────────────────────────────────────────────────────────────

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}

function normaliseKey(raw) {
  return String(raw).toLowerCase().replace(/[\s_-]/g, '');
}

// ── Request handler ───────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/scrape') {
    return send(res, 404, { error: 'Not found. Use: POST /scrape' });
  }

  // Parse body
  let body;
  try {
    body = await readBody(req);
  } catch {
    return send(res, 400, { error: 'Request body must be valid JSON' });
  }

  // Normalise sources — accept a string or an array
  const rawSources = Array.isArray(body.sources)
    ? body.sources
    : [body.sources];

  const invalid = rawSources.filter((s) => !SCRAPERS[normaliseKey(s)]);
  if (rawSources.length === 0 || invalid.length > 0) {
    return send(res, 400, {
      error: `Unknown source(s): ${invalid.join(', ')}. Valid values: ${VALID_SOURCES}`,
    });
  }

  // Validate pages
  const pages = parseInt(body.pages, 10);
  if (isNaN(pages) || pages < 1) {
    return send(res, 400, { error: '"pages" must be a positive integer' });
  }

  const sourceKeys = rawSources.map(normaliseKey);
  console.log(`[API] POST /scrape  sources=[${sourceKeys.join(', ')}]  pages=${pages}`);

  // Run all requested scrapers in parallel
  try {
    const results = await Promise.all(
      sourceKeys.map(async (key) => {
        const scraper = SCRAPERS[key]();
        const listings = await scraper.scrape(pages);
        console.log(`[API] ${scraper.name} — ${listings.length} listings`);
        return { name: scraper.name, listings };
      }),
    );

    const listings = results.flatMap((r) => r.listings);
    const by_source = Object.fromEntries(results.map((r) => [r.name, r.listings.length]));

    return send(res, 200, {
      pages,
      count: listings.length,
      by_source,
      listings,
    });
  } catch (err) {
    console.error(`[API] Scrape failed: ${err.message}`);
    return send(res, 500, { error: 'Scrape failed', detail: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Acquiro Scraper API listening on http://localhost:${PORT}`);
  console.log(`POST /scrape  { "sources": "rightbiz|cogogo|daltons|businessesforsale|all", "pages": 3 }`);
});
