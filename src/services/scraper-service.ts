import { normalizeAddress } from '../normalize/address.js';
import { Cache } from '../cache/cache.js';
import { ContextPool, type AcquiredContext } from '../pool/context-pool.js';
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

    if (this.scrapers.length === 0) {
      return { address: normalized, cached: false, durationMs: 0, results: {} };
    }

    const cached = this.cache.get(normalized) as Record<string, ScrapeResult> | null;

    if (cached) {
      // Identify providers with non-success results that need a fresh attempt
      const staleScrapers = this.scrapers.filter((s) => cached[s.name]?.status !== 'success');

      if (staleScrapers.length === 0) {
        // All providers succeeded in cache — return immediately
        this.logger.info({ address: normalized }, 'Cache hit — all providers successful');
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

      // Partial cache hit — good providers served from cache, stale ones re-scraped
      const goodSites = this.scrapers
        .filter((s) => !staleScrapers.includes(s))
        .map((s) => s.name);
      this.logger.info(
        { address: normalized, cached: goodSites, refreshing: staleScrapers.map((s) => s.name) },
        'Partial cache hit — refreshing stale providers',
      );
      for (const site of goodSites) {
        scrapeRequestsTotal.labels(site, 'cached').inc();
      }

      const freshResults = await this.runScrapers(staleScrapers, normalized);
      const merged = { ...cached, ...freshResults };

      const hasSuccess = Object.values(merged).some((r) => r.status === 'success');
      if (hasSuccess) {
        this.cache.set(normalized, merged);
      }

      const durationMs = Date.now() - startTime;
      const summary = Object.fromEntries(Object.entries(merged).map(([k, v]) => [k, v.status]));
      this.logger.info({ address: normalized, durationMs, results: summary }, 'Partial refresh finished');

      return { address: normalized, cached: false, durationMs, results: merged };
    }

    // Full scrape — nothing cached
    this.logger.info({ address: normalized, sites: this.scrapers.map((s) => s.name).join(', ') }, 'Starting scrape');
    const results = await this.runScrapers(this.scrapers, normalized);

    const durationMs = Date.now() - startTime;
    const summary = Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.status]));
    this.logger.info({ address: normalized, durationMs, results: summary }, 'Scrape finished');

    const hasSuccess = Object.values(results).some((r) => r.status === 'success');
    if (hasSuccess) {
      this.cache.set(normalized, results);
    }

    return { address: normalized, cached: false, durationMs, results };
  }

  private async runScrapers(
    scrapers: Scraper[],
    address: string,
  ): Promise<Record<string, ScrapeResult>> {
    const scrapeAll = async (): Promise<Record<string, ScrapeResult>> => {
      const settled = await Promise.allSettled(
        scrapers.map((scraper) =>
          this.scrapeWithRetry(scraper, address, this.config.scrapeTimeoutMs),
        ),
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
      setTimeout(() => reject(new Error('REQUEST_TIMEOUT')), this.config.requestTimeoutMs);
    });

    try {
      return await Promise.race([scrapeAll(), timeoutPromise]);
    } catch {
      const results: Record<string, ScrapeResult> = {};
      for (const scraper of scrapers) {
        results[scraper.name] = { status: 'timeout', error: 'Request timeout exceeded' };
        scrapeRequestsTotal.labels(scraper.name, 'timeout').inc();
      }
      return results;
    }
  }

  private async scrapeWithRetry(
    scraper: Scraper,
    address: string,
    timeoutMs: number,
  ): Promise<ScrapeResult> {
    const site = scraper.name;
    activeScrapes.inc();
    const timer = scrapeDurationSeconds.startTimer({ site });

    let acquired: AcquiredContext = await this.pool.acquire(site);
    try {
      const result = await scraper.scrape(acquired.context, address, timeoutMs, acquired.landingPage);

      if (result.status === 'success') {
        scrapeRequestsTotal.labels(site, 'success').inc();
        timer();
        activeScrapes.dec();
        await this.pool.release(site, acquired.context);
        return result;
      }

      // First attempt failed — retire context and retry once
      if (
        result.status === 'blocked' ||
        result.status === 'error' ||
        result.status === 'timeout'
      ) {
        this.logger.warn({ site, address, status: result.status }, 'First attempt failed, retrying');
        void acquired.context.close().catch(() => {});
        await this.delay(RETRY_DELAY_MS);

        try {
          acquired = await this.pool.acquire(site);
        } catch (acquireErr) {
          scrapeRequestsTotal.labels(site, 'error').inc();
          timer();
          activeScrapes.dec();
          return { status: 'error', error: String(acquireErr) };
        }
        try {
          const retryResult = await scraper.scrape(acquired.context, address, timeoutMs, acquired.landingPage);
          scrapeRequestsTotal.labels(site, retryResult.status).inc();
          timer();
          activeScrapes.dec();
          await this.pool.release(site, acquired.context);
          return retryResult;
        } catch (retryErr) {
          scrapeRequestsTotal.labels(site, 'error').inc();
          timer();
          activeScrapes.dec();
          await this.pool.release(site, acquired.context);
          return { status: 'error', error: String(retryErr) };
        }
      }

      // Unhandled status — pass through
      scrapeRequestsTotal.labels(site, result.status).inc();
      timer();
      activeScrapes.dec();
      await this.pool.release(site, acquired.context);
      return result;
    } catch (err) {
      // First attempt threw — retire context and retry once
      this.logger.warn({ site, address, err }, 'First attempt threw, retrying');
      void acquired.context.close().catch(() => {});
      await this.delay(RETRY_DELAY_MS);

      try {
        acquired = await this.pool.acquire(site);
      } catch (acquireErr) {
        scrapeRequestsTotal.labels(site, 'error').inc();
        timer();
        activeScrapes.dec();
        return { status: 'error', error: String(acquireErr) };
      }
      try {
        const retryResult = await scraper.scrape(acquired.context, address, timeoutMs, acquired.landingPage);
        scrapeRequestsTotal.labels(site, retryResult.status).inc();
        timer();
        activeScrapes.dec();
        await this.pool.release(site, acquired.context);
        return retryResult;
      } catch (retryErr) {
        scrapeRequestsTotal.labels(site, 'error').inc();
        timer();
        activeScrapes.dec();
        await this.pool.release(site, acquired.context);
        return { status: 'error', error: String(retryErr) };
      }
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
