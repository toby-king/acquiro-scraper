/**
 * Per-domain rate limiter with randomised jitter.
 * Ensures we wait 2–5 seconds between requests to the same hostname.
 */

const MIN_DELAY_MS = 2000;
const MAX_DELAY_MS = 5000;

/** @type {Map<string, number>} hostname → timestamp of last request */
const lastRequestAt = new Map();

/**
 * Wait long enough so we respect the per-domain rate limit.
 * Call this before every outbound request.
 * @param {string} url  Full URL of the request about to be made.
 */
export async function rateLimit(url) {
  const { hostname } = new URL(url);
  const now = Date.now();
  const last = lastRequestAt.get(hostname) ?? 0;
  const elapsed = now - last;
  const required = randomInt(MIN_DELAY_MS, MAX_DELAY_MS);

  if (elapsed < required) {
    const wait = required - elapsed;
    await sleep(wait);
  }

  lastRequestAt.set(hostname, Date.now());
}

/**
 * Return a random integer in [min, max] (inclusive).
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Promisified setTimeout.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { sleep, randomInt };
