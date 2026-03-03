/**
 * Acquiro Scraper — HTTP API server.
 *
 * POST /scrape
 *   Body (JSON): { "source": "rightbiz", "pages": 3 }
 *   Response:    { "source": "Rightbiz", "pages": 3, "count": 25, "listings": [...] }
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

  // Validate source
  const sourceKey = String(body.source ?? '').toLowerCase().replace(/[\s_-]/g, '');
  const factory = SCRAPERS[sourceKey];
  if (!factory) {
    return send(res, 400, {
      error: `Unknown source "${body.source}". Valid values: ${VALID_SOURCES}`,
    });
  }

  // Validate pages
  const pages = parseInt(body.pages, 10);
  if (isNaN(pages) || pages < 1) {
    return send(res, 400, { error: '"pages" must be a positive integer' });
  }

  // Run
  console.log(`[API] POST /scrape  source=${sourceKey}  pages=${pages}`);
  try {
    const scraper = factory();
    const listings = await scraper.scrape(pages);
    console.log(`[API] Done — ${listings.length} listings returned`);
    return send(res, 200, {
      source: scraper.name,
      pages,
      count: listings.length,
      listings,
    });
  } catch (err) {
    console.error(`[API] Scrape failed: ${err.message}`);
    return send(res, 500, { error: 'Scrape failed', detail: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Acquiro Scraper API listening on http://localhost:${PORT}`);
  console.log(`POST /scrape  { "source": "rightbiz|cogogo|daltons|businessesforsale", "pages": 3 }`);
});
