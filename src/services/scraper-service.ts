import { normalizeAddress } from '../normalize/address.js';
import { Cache } from '../cache/cache.js';
import { ContextPool } from '../pool/context-pool.js';
import type { Scraper, ScrapeResult } from '../scrapers/types.js';
import {
  scrapeRequestsTotal,
  scrapeDurationSeconds,
  activeScrapes,
} from '../metrics/index.js';
import { createLogger } from '../utils/logger.js';

const RETRY_DELAY_MS = 2000;

export interface ScraperServiceConfig {
  scrapeTimeoutMs: number;
  requestTimeoutMs: number;
  logLevel?: string;
}

export interface ScrapeResponse {
  address: string;
  cached: boolean;
  durationMs: number;
  results: Record<string, ScrapeResult>;
}

export class ScraperService {
  private readonly logger: ReturnType<typeof createLogger>;

  constructor(
    private readonly cache: Cache,
    private readonly pool: ContextPool,
    private readonly scrapers: Scraper[],
    private readonly config: ScraperServiceConfig,
  ) {
    this.logger = createLogger(config.logLevel ?? 'info');
  }

  async scrape(address: string): Promise<ScrapeResponse> {
    const startTime = Date.now();
    const normalized = normalizeAddress(address);

    // Cache hit — return immediately
    const cached = this.cache.get(normalized) as Record<string, ScrapeResult> | null;
    if (cached) {
      this.logger.info({ address: normalized }, 'Cache hit — returning cached result');
      for (const site of Object.keys(cached)) {
        scrapeRequestsTotal.labels(site, 'cached').inc();
      }
      return {
        address: normalized,
        cached: true,
        durationMs: Date.now() - startTime,
        results: cached,
      };
    }

    // No scrapers configured — return empty
    if (this.scrapers.length === 0) {
      return {
        address: normalized,
        cached: false,
        durationMs: Date.now() - startTime,
        results: {},
      };
    }

    const sites = this.scrapers.map((s) => s.name).join(', ');
    this.logger.info({ address: normalized, sites }, 'Starting scrape');

    // Parallel scrape with hard ceiling
    const scrapeAll = async (): Promise<Record<string, ScrapeResult>> => {
      const settled = await Promise.allSettled(
        this.scrapers.map((scraper) =>
          this.scrapeWithRetry(scraper, normalized, this.config.scrapeTimeoutMs),
        ),
      );

      const results: Record<string, ScrapeResult> = {};
      for (let i = 0; i < this.scrapers.length; i++) {
        const outcome = settled[i]!;
        const site = this.scrapers[i]!.name;
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
      setTimeout(() => reject(new Error('REQUEST_TIMEOUT')), this.config.requestTimeoutMs);
    });

    let results: Record<string, ScrapeResult>;
    try {
      results = await Promise.race([scrapeAll(), timeoutPromise]);
    } catch {
      results = {};
      for (const scraper of this.scrapers) {
        results[scraper.name] = { status: 'timeout', error: 'Request timeout exceeded' };
        scrapeRequestsTotal.labels(scraper.name, 'timeout').inc();
      }
    }

    const durationMs = Date.now() - startTime;
    const summary = Object.fromEntries(
      Object.entries(results).map(([site, r]) => [site, r.status]),
    );
    this.logger.info({ address: normalized, durationMs, results: summary }, 'Scrape finished');

    // Cache only if at least one scraper succeeded
    const hasSuccess = Object.values(results).some((r) => r.status === 'success');
    if (hasSuccess) {
      this.cache.set(normalized, results);
    }

    return {
      address: normalized,
      cached: false,
      durationMs,
      results,
    };
  }

  private async scrapeWithRetry(
    scraper: Scraper,
    address: string,
    timeoutMs: number,
  ): Promise<ScrapeResult> {
    const site = scraper.name;
    activeScrapes.inc();
    const timer = scrapeDurationSeconds.startTimer({ site });

    let context = await this.pool.acquire(site);
    try {
      const result = await scraper.scrape(context, address, timeoutMs);

      if (result.status === 'success') {
        scrapeRequestsTotal.labels(site, 'success').inc();
        timer();
        activeScrapes.dec();
        await this.pool.release(site, context);
        return result;
      }

      // First attempt failed — retire context and retry once
      if (
        result.status === 'blocked' ||
        result.status === 'error' ||
        result.status === 'timeout'
      ) {
        this.logger.warn({ site, address, status: result.status }, 'First attempt failed, retrying');
        void context.close().catch(() => {});
        await this.delay(RETRY_DELAY_MS);

        context = await this.pool.acquire(site);
        try {
          const retryResult = await scraper.scrape(context, address, timeoutMs);
          scrapeRequestsTotal.labels(site, retryResult.status).inc();
          timer();
          activeScrapes.dec();
          await this.pool.release(site, context);
          return retryResult;
        } catch (retryErr) {
          scrapeRequestsTotal.labels(site, 'error').inc();
          timer();
          activeScrapes.dec();
          await this.pool.release(site, context);
          return { status: 'error', error: String(retryErr) };
        }
      }

      // Unhandled status — pass through
      scrapeRequestsTotal.labels(site, result.status).inc();
      timer();
      activeScrapes.dec();
      await this.pool.release(site, context);
      return result;
    } catch (err) {
      // First attempt threw — retire context and retry once
      this.logger.warn({ site, address, err }, 'First attempt threw, retrying');
      void context.close().catch(() => {});
      await this.delay(RETRY_DELAY_MS);

      context = await this.pool.acquire(site);
      try {
        const retryResult = await scraper.scrape(context, address, timeoutMs);
        scrapeRequestsTotal.labels(site, retryResult.status).inc();
        timer();
        activeScrapes.dec();
        await this.pool.release(site, context);
        return retryResult;
      } catch (retryErr) {
        scrapeRequestsTotal.labels(site, 'error').inc();
        timer();
        activeScrapes.dec();
        await this.pool.release(site, context);
        return { status: 'error', error: String(retryErr) };
      }
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
