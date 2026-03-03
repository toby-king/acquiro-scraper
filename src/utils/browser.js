/**
 * Stealth browser utility.
 * Wraps playwright-extra + puppeteer-extra-plugin-stealth to create
 * isolated, fingerprint-resistant browser contexts.
 */
import os from 'os';
import path from 'path';
import { existsSync } from 'fs';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import UserAgent from 'user-agents';

// ── Browser path resolution ───────────────────────────────────────────────────
// Playwright looks up the browser at launch() time using PLAYWRIGHT_BROWSERS_PATH.
// The preview tool runs in a restricted process context, so we explicitly point
// to the project-local browser copy that was installed with:
//   PLAYWRIGHT_BROWSERS_PATH=.playwright-browsers npx playwright install chromium
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  // __dirname equivalent for ES modules
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
  const localBrowsers = path.resolve(here, '../../.playwright-browsers');
  if (existsSync(localBrowsers)) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = localBrowsers;
  }
}

// Register the stealth plugin once at module load time
chromium.use(StealthPlugin());

// ── System Chrome path (Windows) ──────────────────────────────────────────────
// Used as executablePath fallback when the Playwright-managed browser is
// unavailable (e.g. sandboxed CI/CD or the Claude Preview tool).
const SYSTEM_CHROME_WIN = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

/**
 * Launch a new stealth Chromium browser instance.
 * Tries the Playwright-managed headless shell first; falls back to system Chrome.
 * @returns {Promise<import('playwright').Browser>}
 */
export async function launchBrowser() {
  const baseArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--disable-gpu',
    '--no-first-run',
    '--no-zygote',
    '--window-size=1920,1080',
  ];

  // First attempt: Playwright-managed browser (no executablePath needed when
  // PLAYWRIGHT_BROWSERS_PATH is set correctly)
  try {
    return await chromium.launch({ headless: true, args: baseArgs });
  } catch (firstErr) {
    // If the managed browser is inaccessible, try the system Chrome installation
    if (process.platform === 'win32' && existsSync(SYSTEM_CHROME_WIN)) {
      console.warn('[browser] Managed browser unavailable; falling back to system Chrome.');
      return await chromium.launch({
        headless: true,
        executablePath: SYSTEM_CHROME_WIN,
        args: baseArgs,
      });
    }
    throw firstErr;
  }
}

/**
 * Create a fresh isolated browser context with realistic settings.
 * Rotates UA, sets locale/timezone, and blocks unnecessary resources.
 * @param {import('playwright').Browser} browser
 * @returns {Promise<import('playwright').BrowserContext>}
 */
export async function createContext(browser) {
  const ua = new UserAgent({ deviceCategory: 'desktop' });

  const context = await browser.newContext({
    userAgent: ua.toString(),
    viewport: { width: 1920, height: 1080 },
    locale: 'en-GB',
    timezoneId: 'Europe/London',
    extraHTTPHeaders: {
      'Accept-Language': 'en-GB,en;q=0.9',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    },
  });

  // Block images, media and fonts to reduce bandwidth and noise
  await context.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (['image', 'media', 'font'].includes(type)) {
      return route.abort();
    }
    return route.continue();
  });

  return context;
}

/**
 * Simulate human-like scrolling through a page (triggers lazy-load).
 * @param {import('playwright').Page} page
 */
export async function humanScroll(page) {
  const scrollHeight = await page.evaluate(
    () => document.documentElement.scrollHeight,
  );

  let currentY = 0;
  while (currentY < scrollHeight) {
    const step = Math.floor(Math.random() * 200) + 80; // 80–280 px
    currentY = Math.min(currentY + step, scrollHeight);
    await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'smooth' }), currentY);
    await page.waitForTimeout(Math.floor(Math.random() * 150) + 50); // 50–200 ms
  }

  // Scroll back up to let the page settle
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  await page.waitForTimeout(300);
}
