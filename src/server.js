/**
 * Acquiro Scraper — HTTP API server.
 *
 * POST /scrape
 *   Body (JSON): { "sources": "rightbiz", "pages": 3 }
 *            or: { "sources": ["rightbiz", "cogogo"], "pages": 3 }
 *
 * POST /api/generate-matches
 *   Body (JSON): { "user_id": "<bubble_user_id>" }
 *
 * Admin endpoints (require Authorization: Bearer <ADMIN_API_KEY>):
 *   GET  /admin/status
 *   POST /admin/scheduler/enable
 *   POST /admin/scheduler/disable
 *   POST /admin/run-pipeline   (202 — async)
 *   POST /admin/run-scrape     (202 — async)
 *   POST /admin/run-matches    (202 — async)
 *
 * Environment variables:
 *   ADMIN_API_KEY  — required to use admin endpoints
 *   SCRAPE_CRON    — cron expression (default: '0 2 * * *')
 *   SCRAPE_PAGES   — pages per scraper in daily pipeline (default: 20)
 *
 * Run:
 *   node src/server.js
 *   PORT=8080 node src/server.js
 */

import { createServer } from 'http';
import cron from 'node-cron';
import { RightbizScraper } from './scrapers/rightbiz.js';
import { CoGoGoScraper } from './scrapers/cogogo.js';
import { DaltonsScraper } from './scrapers/daltons.js';
import { BusinessesForSaleScraper } from './scrapers/businessesforsale.js';
import { getBuyerInfo, getActiveSubscribers, createScrapeLog, getLatestScrapeLog } from './utils/bubbleClient.js';
import { generateMatchesForUser } from './utils/matcher.js';
import { runArchiver } from './archiver.js';
import { runEmailNotifications, sendEmailForUser } from './utils/emailNotifier.js';

const PORT = parseInt(process.env.PORT ?? '3000', 10);

const SCRAPERS = {
  rightbiz:          () => new RightbizScraper(),
  cogogo:            () => new CoGoGoScraper(),
  daltons:           () => new DaltonsScraper(),
  businessesforsale: () => new BusinessesForSaleScraper(),
  bfs:               () => new BusinessesForSaleScraper(),
};

const VALID_SOURCES = Object.keys(SCRAPERS).filter((k) => k !== 'bfs').join(', ');

// ── Generic helpers ───────────────────────────────────────────────────────────

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    ...CORS_HEADERS,
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

// ── Admin auth ────────────────────────────────────────────────────────────────

function checkAdminAuth(req) {
  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey) return false;
  const header = req.headers['authorization'] ?? '';
  return header === `Bearer ${adminKey}`;
}

// ── Pipeline helpers ──────────────────────────────────────────────────────────

async function runScrape() {
  const sources = ['rightbiz', 'cogogo', 'daltons', 'businessesforsale'];
  const pages   = parseInt(process.env.SCRAPE_PAGES ?? '20', 10);

  let totalListings = 0;
  let totalAdded    = 0;
  for (const key of sources) {
    try {
      const scraper = SCRAPERS[key]();
      const listings = await scraper.scrape(pages);
      const added = listings.filter(l => l?.db_id != null).length;
      console.log(`[pipeline] ${scraper.name} — ${listings.length} listings, ${added} new`);
      totalListings += listings.length;
      totalAdded    += added;
    } catch (err) {
      console.error(`[pipeline] ${key} scraper failed: ${err.message}`);
    }
  }
  console.log(`[pipeline] Scraping complete — ${totalListings} listings total, ${totalAdded} new`);
  return { totalListings, totalAdded };
}

async function runMatches() {
  const userIds = await getActiveSubscribers();
  console.log(`[pipeline] Running matches for ${userIds.length} active subscribers…`);

  let matched = 0;
  for (const userId of userIds) {
    try {
      const result = await generateMatchesForUser(userId);
      console.log(`[pipeline] user=${userId} → ${result.matched ?? 0} new matches`);
      matched += result.matched ?? 0;
    } catch (err) {
      console.error(`[pipeline] Matching failed for user=${userId}: ${err.message}`);
    }
  }
  console.log(`[pipeline] Matching complete — ${matched} total new matches across ${userIds.length} users`);
  return { matched, users: userIds.length };
}

async function runDailyPipeline() {
  console.log('[pipeline] Starting daily pipeline…');
  const { totalAdded }  = await runScrape();
  const { archived }    = await runArchiver();
  const matchResult     = await runMatches();

  console.log(`[pipeline] Done — ${totalAdded} added, ${archived} archived, ${matchResult.matched} matches across ${matchResult.users} users`);

  try {
    await createScrapeLog({ added: totalAdded, archived, matches: matchResult.matched });
    console.log('[pipeline] Scrape log written to Bubble');
  } catch (err) {
    console.error(`[pipeline] Failed to write scrape log: ${err.message}`);
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

let schedulerEnabled = true;
const cronExpression = process.env.SCRAPE_CRON ?? '0 2 * * *';

const scheduledJob = cron.schedule(cronExpression, async () => {
  if (!schedulerEnabled) {
    console.log('[scheduler] Job fired but scheduler is disabled — skipping');
    return;
  }
  console.log('[scheduler] Daily pipeline triggered by cron');
  await runDailyPipeline().catch((err) =>
    console.error('[scheduler] Pipeline failed:', err.message),
  );
}, { scheduled: true, timezone: 'Europe/London' });

console.log(`[scheduler] Daily pipeline scheduled: ${cronExpression} (Europe/London)`);

// ── Email scheduler (8am GMT daily) ───────────────────────────────────────────

cron.schedule('0 8 * * *', async () => {
  console.log('[scheduler] Daily email notifications triggered by cron');
  await runEmailNotifications().catch((err) =>
    console.error('[scheduler] Email notifications failed:', err.message),
  );
}, { scheduled: true, timezone: 'Europe/London' });

console.log('[scheduler] Daily email notifications scheduled: 0 8 * * * (Europe/London)');

// ── Request handler ───────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const { method, url } = req;

  // ── CORS preflight ──────────────────────────────────────────────────────────
  if (method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  // ── POST /scrape ────────────────────────────────────────────────────────────
  if (method === 'POST' && url === '/scrape') {
    let body;
    try {
      body = await readBody(req);
    } catch {
      return send(res, 400, { error: 'Request body must be valid JSON' });
    }

    const rawSources = Array.isArray(body.sources) ? body.sources : [body.sources];
    const invalid = rawSources.filter((s) => !SCRAPERS[normaliseKey(s)]);
    if (rawSources.length === 0 || invalid.length > 0) {
      return send(res, 400, {
        error: `Unknown source(s): ${invalid.join(', ')}. Valid values: ${VALID_SOURCES}`,
      });
    }

    const pages = parseInt(body.pages, 10);
    if (isNaN(pages) || pages < 1) {
      return send(res, 400, { error: '"pages" must be a positive integer' });
    }

    const sourceKeys = rawSources.map(normaliseKey);
    console.log(`[API] POST /scrape  sources=[${sourceKeys.join(', ')}]  pages=${pages}`);

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

      return send(res, 200, { pages, count: listings.length, by_source, listings });
    } catch (err) {
      console.error(`[API] Scrape failed: ${err.message}`);
      return send(res, 500, { error: 'Scrape failed', detail: err.message });
    }
  }

  // ── POST /api/generate-matches ──────────────────────────────────────────────
  if (method === 'POST' && url === '/api/generate-matches') {
    let body;
    try {
      body = await readBody(req);
    } catch {
      return send(res, 400, { error: 'Request body must be valid JSON' });
    }

    if (!body.user_id) {
      return send(res, 400, { error: 'user_id is required' });
    }

    try {
      // Verify buyer profile exists before delegating
      const profileRes = await getBuyerInfo(body.user_id);
      if (!profileRes || profileRes.count === 0) {
        return send(res, 404, { error: 'No Buyer_Info found for this user' });
      }

      const result = await generateMatchesForUser(body.user_id);
      return send(res, 200, result);
    } catch (err) {
      console.error(`[API] generate-matches failed: ${err.message}`);
      return send(res, 500, { error: 'Match generation failed', detail: err.message });
    }
  }

  // ── Admin endpoints ─────────────────────────────────────────────────────────

  if (url.startsWith('/admin')) {
    if (!process.env.ADMIN_API_KEY) {
      return send(res, 503, { error: 'Admin endpoints are not configured (ADMIN_API_KEY not set)' });
    }
    if (!checkAdminAuth(req)) {
      return send(res, 401, { error: 'Unauthorized' });
    }

    if (method === 'GET' && url === '/admin/status') {
      let lastLog = null;
      try {
        lastLog = await getLatestScrapeLog();
      } catch (err) {
        console.warn('[admin] Could not fetch scrape log:', err.message);
      }
      return send(res, 200, {
        schedulerEnabled,
        cronExpression,
        timezone: 'Europe/London',
        lastRun:          lastLog?.last_run_date          ?? null,
        lastRunAdded:     lastLog?.records_added_number   ?? null,
        lastRunArchived:  lastLog?.records_archived_number ?? null,
        lastRunMatches:   lastLog?.matched_made_number    ?? null,
      });
    }

    if (method === 'POST' && url === '/admin/scheduler/enable') {
      schedulerEnabled = true;
      console.log('[admin] Scheduler enabled');
      return send(res, 200, { ok: true, schedulerEnabled });
    }

    if (method === 'POST' && url === '/admin/scheduler/disable') {
      schedulerEnabled = false;
      console.log('[admin] Scheduler disabled');
      return send(res, 200, { ok: true, schedulerEnabled });
    }

    if (method === 'POST' && url === '/admin/run-pipeline') {
      console.log('[admin] Manual full pipeline triggered');
      runDailyPipeline().catch((err) =>
        console.error('[admin] Pipeline failed:', err.message),
      );
      return send(res, 202, { ok: true, message: 'Pipeline started' });
    }

    if (method === 'POST' && url === '/admin/run-scrape') {
      console.log('[admin] Manual scrape triggered');
      runScrape().catch((err) =>
        console.error('[admin] Scrape failed:', err.message),
      );
      return send(res, 202, { ok: true, message: 'Scrape started' });
    }

    if (method === 'POST' && url === '/admin/run-matches') {
      console.log('[admin] Manual match run triggered');
      runMatches().catch((err) =>
        console.error('[admin] Match run failed:', err.message),
      );
      return send(res, 202, { ok: true, message: 'Match run started' });
    }

    if (method === 'POST' && url === '/admin/run-emails') {
      console.log('[admin] Manual email notifications triggered');
      runEmailNotifications().catch((err) =>
        console.error('[admin] Email notifications failed:', err.message),
      );
      return send(res, 202, { ok: true, message: 'Email notifications started' });
    }

    if (method === 'POST' && url === '/admin/test-email') {
      let body;
      try {
        body = await readBody(req);
      } catch {
        return send(res, 400, { error: 'Request body must be valid JSON' });
      }
      if (!body.user_id) {
        return send(res, 400, { error: 'user_id is required' });
      }
      try {
        const result = await sendEmailForUser(body.user_id);
        return send(res, 200, { ok: true, ...result });
      } catch (err) {
        console.error(`[admin] test-email failed: ${err.message}`);
        return send(res, 500, { error: 'Email failed', detail: err.message });
      }
    }

    return send(res, 404, { error: 'Unknown admin endpoint' });
  }

  // ── 404 fallback ────────────────────────────────────────────────────────────
  return send(res, 404, {
    error: 'Not found. Available: POST /scrape, POST /api/generate-matches, GET /admin/status',
  });
});

server.listen(PORT, () => {
  console.log(`Acquiro Scraper API listening on http://localhost:${PORT}`);
  console.log(`POST /scrape               { "sources": "rightbiz|cogogo|daltons|businessesforsale", "pages": 3 }`);
  console.log(`POST /api/generate-matches { "user_id": "<bubble_user_id>" }`);
  console.log(`GET  /admin/status         (requires ADMIN_API_KEY)`);
});
