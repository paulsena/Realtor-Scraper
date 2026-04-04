# ScraperService + Integration Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract scrape-and-cache orchestration from `house-value.ts` into a reusable `ScraperService` class, then add an integration test that clears cache, does a live 3-site scrape of a real address, asserts all data fields, then asserts the cache is hit on a second call.

**Architecture:** A new `ScraperService` class owns all scraping + caching business logic (normalize address, cache check, parallel scrape with retry, conditional cache write). The Express route becomes a thin HTTP adapter. The integration test bypasses HTTP entirely and exercises `ScraperService` + `Cache` + `ContextPool` directly with real browser contexts.

**Tech Stack:** TypeScript, Vitest, rebrowser-playwright, better-sqlite3, prom-client

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/services/scraper-service.ts` | ScraperService class — normalization, cache, parallel scrape, retry logic |
| Modify | `src/cache/cache.ts` | Add `delete(normalizedAddress)` method |
| Modify | `src/routes/house-value.ts` | Thin HTTP adapter — validate input, call `service.scrape()`, format response |
| Modify | `src/index.ts` | Construct `ScraperService`, pass to `initHouseValueRoute` |
| Modify | `src/__tests__/server.test.ts` | Update `initHouseValueRoute` call to new single-arg signature |
| Modify | `vitest.config.ts` | Exclude `*.integration.test.ts` from unit run |
| Create | `vitest.integration.config.ts` | Integration test config — 180s timeout, only `*.integration.test.ts` |
| Modify | `package.json` | Add `test:unit`, `test:integration` scripts; update `test` to run both |
| Create | `src/__tests__/scraper-service.integration.test.ts` | Integration test: cache clear → live scrape → assert data → assert cache hit |

---

## Task 1: Add `Cache.delete()` method

**Files:**
- Modify: `src/cache/cache.ts`

- [ ] **Step 1: Add the `delete` method to the `Cache` class**

  In `src/cache/cache.ts`, add this method after the `clear()` method:

  ```typescript
  /** Remove a specific cache entry by normalized address. */
  delete(normalizedAddress: string): void {
    this.db.prepare('DELETE FROM cache WHERE address = ?').run(normalizedAddress);
  }
  ```

- [ ] **Step 2: Commit**

  ```bash
  git add src/cache/cache.ts
  git commit -m "feat(cache): add delete() method for removing specific entries"
  ```

---

## Task 2: Create `ScraperService`

**Files:**
- Create: `src/services/scraper-service.ts`

- [ ] **Step 1: Create the file**

  Create `src/services/scraper-service.ts` with this full content:

  ```typescript
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

      // Cache only if at least one scraper succeeded
      const hasSuccess = Object.values(results).some((r) => r.status === 'success');
      if (hasSuccess) {
        this.cache.set(normalized, results);
      }

      return {
        address: normalized,
        cached: false,
        durationMs: Date.now() - startTime,
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
          this.logger.warn({ site, status: result.status }, 'First attempt failed, retrying');
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
        this.logger.warn({ site, err }, 'First attempt threw, retrying');
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
  ```

- [ ] **Step 2: Commit**

  ```bash
  git add src/services/scraper-service.ts
  git commit -m "feat(services): add ScraperService — extracts scrape+cache orchestration from route"
  ```

---

## Task 3: Slim down `house-value.ts` to use `ScraperService`

**Files:**
- Modify: `src/routes/house-value.ts`

- [ ] **Step 1: Replace the entire file contents**

  Replace `src/routes/house-value.ts` with:

  ```typescript
  import { Router } from 'express';
  import { v4 as uuidv4 } from 'uuid';
  import { ScraperService } from '../services/scraper-service.js';

  /** Set via `initHouseValueRoute` before the server starts. */
  let service: ScraperService;

  export function initHouseValueRoute(s: ScraperService): void {
    service = s;
  }

  const router = Router();

  router.get('/api/house-value', async (req, res) => {
    const requestId = uuidv4();

    try {
      const address = req.query['address'];
      if (!address || typeof address !== 'string' || address.trim().length === 0) {
        res.status(400).json({ error: 'Missing or empty required query parameter: address' });
        return;
      }
      if (address.length > 200) {
        res.status(400).json({ error: 'Address must be 200 characters or fewer' });
        return;
      }

      const response = await service.scrape(address);

      res.json({
        requestId,
        ...response,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      res.status(500).json({ error: 'Internal server error', requestId });
    }
  });

  export default router;
  ```

- [ ] **Step 2: Commit**

  ```bash
  git add src/routes/house-value.ts
  git commit -m "refactor(routes): slim house-value route to delegate to ScraperService"
  ```

---

## Task 4: Update `index.ts` to construct and wire `ScraperService`

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Import `ScraperService` and the three scrapers, update the wiring**

  Replace the import block and the `initHouseValueRoute` call in `src/index.ts`.

  Change the imports at the top (add these three lines, keep the rest):

  ```typescript
  import { ScraperService } from './services/scraper-service.js';
  import { ZillowScraper } from './scrapers/zillow.js';
  import { RedfinScraper } from './scrapers/redfin.js';
  import { RealtorScraper } from './scrapers/realtor.js';
  ```

  Replace the `initHouseValueRoute(cache, pool)` call with:

  ```typescript
  // Build enabled scrapers and wire ScraperService
  const scrapers = [];
  if (config.scrapers.zillowEnabled) scrapers.push(new ZillowScraper());
  if (config.scrapers.redfinEnabled) scrapers.push(new RedfinScraper());
  if (config.scrapers.realtorEnabled) scrapers.push(new RealtorScraper());

  const scraperService = new ScraperService(cache, pool, scrapers, {
    scrapeTimeoutMs: config.scrapeTimeoutMs,
    requestTimeoutMs: config.requestTimeoutMs,
    logLevel: config.logLevel,
  });
  initHouseValueRoute(scraperService);
  ```

- [ ] **Step 2: Commit**

  ```bash
  git add src/index.ts
  git commit -m "feat(index): construct ScraperService and wire to house-value route"
  ```

---

## Task 5: Fix `server.test.ts` for new `initHouseValueRoute` signature

**Files:**
- Modify: `src/__tests__/server.test.ts`

- [ ] **Step 1: Update the test's `initHouseValueRoute` call**

  In `src/__tests__/server.test.ts`, the `beforeAll` currently does:

  ```typescript
  import { ScraperService } from '../services/scraper-service.js';
  // ... (add to existing imports)
  ```

  Replace the `beforeAll` block with:

  ```typescript
  beforeAll(() => {
    process.env['API_KEY'] = 'test-api-key';
    config = loadConfig();
    app = createApp(config);
    const db = initDatabase(':memory:');
    const cache = new Cache(db, 14);
    const service = new ScraperService(cache, null as never, [], {
      scrapeTimeoutMs: 5000,
      requestTimeoutMs: 10000,
    });
    initHouseValueRoute(service);
  });
  ```

  Also update the imports at the top of the file — remove the old `initHouseValueRoute` import if it still references the old signature (it will still be imported from `'../routes/house-value.js'`, just used differently), and add the `ScraperService` import:

  ```typescript
  import { ScraperService } from '../services/scraper-service.js';
  ```

- [ ] **Step 2: Run unit tests to verify they still pass**

  ```bash
  npx vitest run
  ```

  Expected: all existing tests in `cache.test.ts`, `address.test.ts`, and `server.test.ts` pass.

- [ ] **Step 3: Commit**

  ```bash
  git add src/__tests__/server.test.ts
  git commit -m "fix(tests): update server.test.ts for new ScraperService-based initHouseValueRoute"
  ```

---

## Task 6: Set up integration test infrastructure

**Files:**
- Modify: `vitest.config.ts`
- Create: `vitest.integration.config.ts`
- Modify: `package.json`

- [ ] **Step 1: Update `vitest.config.ts` to exclude integration tests**

  Replace `vitest.config.ts` with:

  ```typescript
  import { defineConfig } from 'vitest/config';

  export default defineConfig({
    test: {
      exclude: ['dist/**', 'node_modules/**', '**/*.integration.test.ts'],
    },
  });
  ```

- [ ] **Step 2: Create `vitest.integration.config.ts`**

  Create `vitest.integration.config.ts` with:

  ```typescript
  import { defineConfig } from 'vitest/config';

  export default defineConfig({
    test: {
      include: ['src/**/*.integration.test.ts'],
      exclude: ['dist/**', 'node_modules/**'],
      testTimeout: 180_000,
      hookTimeout: 60_000,
    },
  });
  ```

- [ ] **Step 3: Update `package.json` scripts**

  Replace the `"scripts"` block in `package.json` with:

  ```json
  "scripts": {
    "dev": "tsx src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "typecheck": "tsc --noEmit",
    "test:unit": "vitest run",
    "test:integration": "vitest run --config vitest.integration.config.ts",
    "test": "npm run test:unit && npm run test:integration"
  },
  ```

- [ ] **Step 4: Commit**

  ```bash
  git add vitest.config.ts vitest.integration.config.ts package.json
  git commit -m "feat(test): add integration test vitest config and split npm test scripts"
  ```

---

## Task 7: Write the integration test

**Files:**
- Create: `src/__tests__/scraper-service.integration.test.ts`

- [ ] **Step 1: Create the integration test file**

  Create `src/__tests__/scraper-service.integration.test.ts` with:

  ```typescript
  import { describe, it, expect, beforeAll, afterAll } from 'vitest';
  import { initDatabase } from '../cache/db.js';
  import { Cache } from '../cache/cache.js';
  import { ContextPool } from '../pool/context-pool.js';
  import { ZillowScraper } from '../scrapers/zillow.js';
  import { RedfinScraper } from '../scrapers/redfin.js';
  import { RealtorScraper } from '../scrapers/realtor.js';
  import { ScraperService } from '../services/scraper-service.js';
  import { normalizeAddress } from '../normalize/address.js';
  import type { ScrapeResult } from '../scrapers/types.js';

  const TEST_ADDRESS = '26 E Chestnut St, Asheville, NC 28801';
  // "26 e chestnut street asheville nc 28801"
  const NORMALIZED_ADDRESS = normalizeAddress(TEST_ADDRESS);

  let cache: Cache;
  let pool: ContextPool;
  let service: ScraperService;

  beforeAll(() => {
    // Required by loadConfig() which ContextPool calls in its constructor
    process.env['API_KEY'] = 'integration-test';

    const db = initDatabase(':memory:');
    cache = new Cache(db, 14);
    pool = new ContextPool();

    service = new ScraperService(
      cache,
      pool,
      [new ZillowScraper(), new RedfinScraper(), new RealtorScraper()],
      {
        scrapeTimeoutMs: 60_000,
        requestTimeoutMs: 120_000,
        logLevel: 'warn', // suppress info noise during tests
      },
    );
  });

  afterAll(async () => {
    await pool.shutdown();
  });

  /**
   * Assert that a single scraper result is structurally valid and contains
   * reasonable data for the test address. All fields we extract from the page
   * are verified here — if a selector breaks, this will fail.
   */
  function assertScrapeResult(site: string, result: ScrapeResult): void {
    // Status must be success — blocked/error means the scraper is broken or blocked
    expect(result.status, `${site}: status`).toBe('success');
    expect(result.error, `${site}: no error string on success`).toBeUndefined();

    // Estimated price — the primary value we scrape
    expect(result.estimatedPrice, `${site}: estimatedPrice is defined`).toBeDefined();
    expect(typeof result.estimatedPrice, `${site}: estimatedPrice is a number`).toBe('number');
    expect(result.estimatedPrice, `${site}: estimatedPrice > $50k`).toBeGreaterThan(50_000);
    expect(result.estimatedPrice, `${site}: estimatedPrice < $5M`).toBeLessThan(5_000_000);

    // Property details
    expect(result.details, `${site}: details object is present`).toBeDefined();

    const { beds, baths, sqft, yearBuilt } = result.details ?? {};

    expect(beds, `${site}: beds is defined`).toBeDefined();
    expect(typeof beds, `${site}: beds is a number`).toBe('number');
    expect(beds, `${site}: beds >= 1`).toBeGreaterThanOrEqual(1);
    expect(beds, `${site}: beds <= 20`).toBeLessThanOrEqual(20);

    expect(baths, `${site}: baths is defined`).toBeDefined();
    expect(typeof baths, `${site}: baths is a number`).toBe('number');
    expect(baths, `${site}: baths >= 1`).toBeGreaterThanOrEqual(1);
    expect(baths, `${site}: baths <= 20`).toBeLessThanOrEqual(20);

    expect(sqft, `${site}: sqft is defined`).toBeDefined();
    expect(typeof sqft, `${site}: sqft is a number`).toBe('number');
    expect(sqft, `${site}: sqft > 0`).toBeGreaterThan(0);
    expect(sqft, `${site}: sqft < 50000`).toBeLessThan(50_000);

    expect(yearBuilt, `${site}: yearBuilt is defined`).toBeDefined();
    expect(typeof yearBuilt, `${site}: yearBuilt is a number`).toBe('number');
    expect(yearBuilt, `${site}: yearBuilt >= 1800`).toBeGreaterThanOrEqual(1800);
    expect(yearBuilt, `${site}: yearBuilt <= ${new Date().getFullYear()}`).toBeLessThanOrEqual(
      new Date().getFullYear(),
    );

    // Sales history — we assert it's an array; entries must have valid shape
    expect(Array.isArray(result.salesHistory), `${site}: salesHistory is an array`).toBe(true);
    for (const entry of result.salesHistory ?? []) {
      expect(typeof entry.date, `${site}: salesHistory[].date is a string`).toBe('string');
      expect(entry.date.length, `${site}: salesHistory[].date is non-empty`).toBeGreaterThan(0);
      expect(typeof entry.price, `${site}: salesHistory[].price is a number`).toBe('number');
      expect(entry.price, `${site}: salesHistory[].price > 0`).toBeGreaterThan(0);
      expect(typeof entry.event, `${site}: salesHistory[].event is a string`).toBe('string');
    }

    // Tax history — same pattern
    expect(Array.isArray(result.taxHistory), `${site}: taxHistory is an array`).toBe(true);
    for (const entry of result.taxHistory ?? []) {
      expect(typeof entry.year, `${site}: taxHistory[].year is a number`).toBe('number');
      expect(entry.year, `${site}: taxHistory[].year >= 1900`).toBeGreaterThanOrEqual(1900);
      expect(entry.year, `${site}: taxHistory[].year <= current year`).toBeLessThanOrEqual(
        new Date().getFullYear(),
      );
      expect(typeof entry.tax, `${site}: taxHistory[].tax is a number`).toBe('number');
      expect(entry.tax, `${site}: taxHistory[].tax >= 0`).toBeGreaterThanOrEqual(0);
      expect(typeof entry.assessment, `${site}: taxHistory[].assessment is a number`).toBe('number');
      expect(entry.assessment, `${site}: taxHistory[].assessment >= 0`).toBeGreaterThanOrEqual(0);
    }

    // Comparables — optional but must have valid shape when present
    if (result.comparables && result.comparables.length > 0) {
      for (const comp of result.comparables) {
        expect(typeof comp.address, `${site}: comparables[].address is a string`).toBe('string');
        expect(comp.address.length, `${site}: comparables[].address is non-empty`).toBeGreaterThan(0);
        expect(typeof comp.price, `${site}: comparables[].price is a number`).toBe('number');
        expect(comp.price, `${site}: comparables[].price > 0`).toBeGreaterThan(0);
      }
    }
  }

  describe('ScraperService integration — 26 E Chestnut St, Asheville NC', () => {
    let firstRunResults: Record<string, ScrapeResult>;

    it(
      'clears cache, performs live scrape, all three scrapers return valid data',
      async () => {
        // Ensure clean slate — delete any previously cached entry for this address
        cache.delete(NORMALIZED_ADDRESS);

        const response = await service.scrape(TEST_ADDRESS);

        // Top-level shape
        expect(response.cached, 'first run: cached is false').toBe(false);
        expect(response.address, 'first run: address is normalized').toBe(NORMALIZED_ADDRESS);
        expect(response.durationMs, 'first run: durationMs > 0').toBeGreaterThan(0);

        // All three scrapers must be present
        expect(response.results, 'results has zillow key').toHaveProperty('zillow');
        expect(response.results, 'results has redfin key').toHaveProperty('redfin');
        expect(response.results, 'results has realtor key').toHaveProperty('realtor');

        // Assert every field for each scraper
        assertScrapeResult('zillow', response.results['zillow']!);
        assertScrapeResult('redfin', response.results['redfin']!);
        assertScrapeResult('realtor', response.results['realtor']!);

        firstRunResults = response.results;
      },
      120_000,
    );

    it(
      'returns cache hit on second request with identical results',
      async () => {
        const response = await service.scrape(TEST_ADDRESS);

        expect(response.cached, 'second run: cached is true').toBe(true);
        expect(response.address, 'second run: address is normalized').toBe(NORMALIZED_ADDRESS);
        // Results must be exactly what was stored — deep equality
        expect(response.results, 'second run: results match first run').toEqual(firstRunResults);
      },
      10_000,
    );
  });
  ```

- [ ] **Step 2: Commit**

  ```bash
  git add src/__tests__/scraper-service.integration.test.ts
  git commit -m "test(integration): add ScraperService integration test for cache+scrape workflow"
  ```

---

## Task 8: Verify everything works

- [ ] **Step 1: Run unit tests**

  ```bash
  npm run test:unit
  ```

  Expected: all tests in `cache.test.ts`, `address.test.ts`, `server.test.ts` pass. The integration test file is excluded.

- [ ] **Step 2: Run integration tests**

  ```bash
  npm run test:integration
  ```

  Expected: both integration tests pass. First test takes 30–120 seconds (live browser scraping). Second test is near-instant (cache hit). You will see the browser launch — that is normal.

  If a scraper returns `status: 'blocked'` or `status: 'error'`, the assertion on that site will fail with a message like `zillow: status — expected 'blocked' to be 'success'`. This means either the site has changed its HTML structure or it detected the bot. Check the scraper logic for that site.

- [ ] **Step 3: Verify `npm test` runs both suites**

  ```bash
  npm test
  ```

  Expected: unit tests pass first, then integration tests pass. Exit code 0.
