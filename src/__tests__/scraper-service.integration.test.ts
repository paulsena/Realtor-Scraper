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
// normalizes to: "26 e chestnut street asheville nc 28801"
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
