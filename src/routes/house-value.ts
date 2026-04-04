import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { loadConfig } from '../config.js';
import { normalizeAddress } from '../normalize/address.js';
import { Cache } from '../cache/cache.js';
import { ContextPool } from '../pool/context-pool.js';
import { ZillowScraper } from '../scrapers/zillow.js';
import { RedfinScraper } from '../scrapers/redfin.js';
import { RealtorScraper } from '../scrapers/realtor.js';
import type { Scraper, ScrapeResult } from '../scrapers/types.js';
import {
  scrapeRequestsTotal,
  scrapeDurationSeconds,
  activeScrapes,
} from '../metrics/index.js';
import { createLogger } from '../utils/logger.js';

const RETRY_DELAY_MS = 2000;

/** Shared instances — set via `initHouseValueRoute` before the server starts. */
let cache: Cache;
let pool: ContextPool;

export function initHouseValueRoute(c: Cache, p: ContextPool): void {
  cache = c;
  pool = p;
}

const router = Router();

router.get('/api/house-value', async (req, res) => {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const requestId = uuidv4();
  const startTime = Date.now();

  try {
    // 1. Validate address query param
    const address = req.query['address'];
    if (!address || typeof address !== 'string' || address.trim().length === 0) {
      res.status(400).json({ error: 'Missing or empty required query parameter: address' });
      return;
    }
    if (address.length > 200) {
      res.status(400).json({ error: 'Address must be 200 characters or fewer' });
      return;
    }

    // 2. Normalize address
    const normalized = normalizeAddress(address);
    logger.info({ requestId, address, normalized }, 'House value request');

    // 3. Check cache
    const cached = cache.get(normalized) as Record<string, ScrapeResult> | null;
    if (cached) {
      // Increment cached counters per site
      for (const site of Object.keys(cached)) {
        scrapeRequestsTotal.labels(site, 'cached').inc();
      }

      const durationMs = Date.now() - startTime;
      res.json({
        requestId,
        address: normalized,
        cached: true,
        durationMs,
        timestamp: new Date().toISOString(),
        results: cached,
      });
      return;
    }

    // 4. Build list of enabled scrapers
    const scrapers: Scraper[] = [];
    if (config.scrapers.zillowEnabled) scrapers.push(new ZillowScraper());
    if (config.scrapers.redfinEnabled) scrapers.push(new RedfinScraper());
    if (config.scrapers.realtorEnabled) scrapers.push(new RealtorScraper());

    if (scrapers.length === 0) {
      res.json({
        requestId,
        address: normalized,
        cached: false,
        durationMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
        results: {},
      });
      return;
    }

    // 5. Scrape in parallel with hard ceiling via Promise.race
    const scrapeAll = async (): Promise<Record<string, ScrapeResult>> => {
      const settled = await Promise.allSettled(
        scrapers.map((scraper) => scrapeWithRetry(scraper, normalized, config.scrapeTimeoutMs, logger)),
      );

      const results: Record<string, ScrapeResult> = {};
      for (let i = 0; i < scrapers.length; i++) {
        const outcome = settled[i]!;
        const site = scrapers[i]!.name;
        if (outcome.status === 'fulfilled') {
          results[site] = outcome.value;
        } else {
          results[site] = { status: 'error', error: String(outcome.reason) };
          scrapeRequestsTotal.labels(site, 'error').inc();
        }
      }
      return results;
    };

    const timeoutPromise = new Promise<Record<string, ScrapeResult>>((_resolve, reject) => {
      setTimeout(() => reject(new Error('REQUEST_TIMEOUT')), config.requestTimeoutMs);
    });

    let results: Record<string, ScrapeResult>;
    try {
      results = await Promise.race([scrapeAll(), timeoutPromise]);
    } catch (err) {
      // Hard ceiling hit — return whatever we have (empty in worst case)
      logger.warn({ requestId, err }, 'Request timeout reached');
      results = {};
      for (const scraper of scrapers) {
        results[scraper.name] = { status: 'timeout', error: 'Request timeout exceeded' };
        scrapeRequestsTotal.labels(scraper.name, 'timeout').inc();
      }
    }

    // 6. Cache successful results (only if at least one success)
    const hasSuccess = Object.values(results).some((r) => r.status === 'success');
    if (hasSuccess) {
      cache.set(normalized, results);
    }

    // 7. Assemble response
    const durationMs = Date.now() - startTime;
    res.json({
      requestId,
      address: normalized,
      cached: false,
      durationMs,
      timestamp: new Date().toISOString(),
      results,
    });
  } catch (err) {
    logger.error({ requestId, err }, 'Unhandled error in house-value route');
    res.status(500).json({ error: 'Internal server error', requestId });
  }
});

async function scrapeWithRetry(
  scraper: Scraper,
  address: string,
  timeoutMs: number,
  logger: ReturnType<typeof createLogger>,
): Promise<ScrapeResult> {
  const site = scraper.name;
  activeScrapes.inc();
  const timer = scrapeDurationSeconds.startTimer({ site });

  let context = await pool.acquire(site);
  try {
    const result = await scraper.scrape(context, address, timeoutMs);

    if (result.status === 'success') {
      scrapeRequestsTotal.labels(site, 'success').inc();
      timer();
      activeScrapes.dec();
      await pool.release(site, context);
      return result;
    }

    // Failed or blocked — retire context and retry once
    if (result.status === 'blocked' || result.status === 'error' || result.status === 'timeout') {
      logger.warn({ site, status: result.status }, 'First attempt failed, retrying');

      // Retire old context (close it, don't return to pool)
      void context.close().catch(() => {});

      // Exponential backoff delay before retry
      await delay(RETRY_DELAY_MS);

      // Acquire fresh context and retry
      context = await pool.acquire(site);
      try {
        const retryResult = await scraper.scrape(context, address, timeoutMs);
        scrapeRequestsTotal.labels(site, retryResult.status).inc();
        timer();
        activeScrapes.dec();
        await pool.release(site, context);
        return retryResult;
      } catch (retryErr) {
        scrapeRequestsTotal.labels(site, 'error').inc();
        timer();
        activeScrapes.dec();
        await pool.release(site, context);
        return { status: 'error', error: String(retryErr) };
      }
    }

    // Shouldn't reach here, but handle gracefully
    scrapeRequestsTotal.labels(site, result.status).inc();
    timer();
    activeScrapes.dec();
    await pool.release(site, context);
    return result;
  } catch (err) {
    // First attempt threw — retire and retry
    logger.warn({ site, err }, 'First attempt threw, retrying');
    void context.close().catch(() => {});

    await delay(RETRY_DELAY_MS);

    context = await pool.acquire(site);
    try {
      const retryResult = await scraper.scrape(context, address, timeoutMs);
      scrapeRequestsTotal.labels(site, retryResult.status).inc();
      timer();
      activeScrapes.dec();
      await pool.release(site, context);
      return retryResult;
    } catch (retryErr) {
      scrapeRequestsTotal.labels(site, 'error').inc();
      timer();
      activeScrapes.dec();
      await pool.release(site, context);
      return { status: 'error', error: String(retryErr) };
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default router;
