import type { Page } from 'rebrowser-playwright';
import { BaseScraper, type ScraperSelectors } from './base-scraper.js';
import type { ScrapeResult } from './types.js';
import type pino from 'pino';

const SELECTORS = {
  // My Home Value page has a dedicated "Enter your address" input
  searchBox: 'input[placeholder="Enter your address"], input#search-box-input',
  autocompleteResult:
    '.item-row.clickable >> nth=0',
  // My Home Value estimate page price
  price:
    '.AvmSection .price, [data-rf-test-name="avmValue"], .statsValue [data-rf-test-id="avm-price"], .HomeInfoV2 .price',
  redfinEstimate:
    '.AvmSection .price, [data-rf-test-name="avmValue"], [data-rf-test-id="avm-price"], .redfin-avm-price, .avm-price',
  beds: '.HomeInfoV2 .beds, [data-rf-test-id="abp-beds"] .statsValue, .home-main-stats-variant span:has(.bp-bed)',
  baths:
    '.HomeInfoV2 .baths, [data-rf-test-id="abp-baths"] .statsValue, .home-main-stats-variant span:has(.bp-bath)',
  sqft: '.HomeInfoV2 .sqft, [data-rf-test-id="abp-sqFt"] .statsValue, .home-main-stats-variant span:has(.bp-sqft)',
  yearBuilt: '.keyDetail:has(span:text("Year Built")) .content',
  lotSize: '.keyDetail:has(span:text("Lot Size")) .content',
  priceHistory:
    '.PropertyHistoryEventRow, [data-rf-test-id="property-history-row"]',
  taxHistory:
    '.TaxHistoryRow, [data-rf-test-id="tax-history-row"]',
  comparables:
    '.ComparableRow, [data-rf-test-id="comparable-row"], .comps-card',
} as const;

export class RedfinScraper extends BaseScraper {
  readonly name = 'redfin';

  constructor(logger?: pino.Logger) {
    super(logger);
  }
  // Use the My Home Value page — its autocomplete API is NOT blocked by CloudFront
  // unlike the regular homepage search which uses the blocked /stingray/do/location-autocomplete
  readonly landingUrl = 'https://www.redfin.com/what-is-my-home-worth';
  protected readonly selectors: ScraperSelectors = {
    searchBox: SELECTORS.searchBox,
    autocompleteResult: SELECTORS.autocompleteResult,
    priceSelector: SELECTORS.price,
  };

  protected async extractData(page: Page): Promise<ScrapeResult> {
    const site = this.name;
    const url = page.url();

    // JSON-LD first strategy
    const jsonLd = await this.extractJsonLd(page);
    if (jsonLd) {
      const types = jsonLd
        .map((item) => (item as Record<string, unknown>)?.['@type'])
        .filter(Boolean);
      this.logger.info({ site, url, count: jsonLd.length, types }, 'DIAG: JSON-LD scripts found');
      const result = this.parseJsonLd(jsonLd);
      if (result) {
        this.logger.info({ site, url, strategy: 'json-ld' }, 'Extracted data via JSON-LD');
        return result;
      }
      this.logger.warn(
        { site, url, types },
        'DIAG: JSON-LD found but no matching property type — falling through',
      );
    } else {
      this.logger.warn({ site, url }, 'DIAG: No JSON-LD scripts found on page');
    }

    // Fallback: DOM scraping
    this.logger.info({ site, url, strategy: 'dom' }, 'Falling back to DOM scraping');
    return this.extractFromDom(page);
  }

  private parseJsonLd(data: unknown[]): ScrapeResult | null {
    for (const item of data) {
      if (
        typeof item === 'object' &&
        item !== null &&
        '@type' in item
      ) {
        const obj = item as Record<string, unknown>;
        const type = obj['@type'];
        if (
          type !== 'SingleFamilyResidence' &&
          type !== 'Residence' &&
          type !== 'Product'
        ) {
          continue;
        }

        const result: ScrapeResult = { status: 'success' };

        if (typeof obj['price'] === 'string' || typeof obj['price'] === 'number') {
          result.estimatedPrice = parseNumeric(String(obj['price']));
        }
        // Redfin sometimes nests price under offers
        const offers = obj['offers'] as Record<string, unknown> | undefined;
        if (!result.estimatedPrice && offers && typeof offers['price'] === 'string') {
          result.estimatedPrice = parseNumeric(offers['price']);
        }

        const details: NonNullable<ScrapeResult['details']> = {};
        if (typeof obj['numberOfBedrooms'] === 'number') {
          details.beds = obj['numberOfBedrooms'];
        }
        if (typeof obj['numberOfBathroomsTotal'] === 'number') {
          details.baths = obj['numberOfBathroomsTotal'];
        }
        const floorSize = obj['floorSize'] as Record<string, unknown> | undefined;
        if (floorSize && typeof floorSize['value'] === 'number') {
          details.sqft = floorSize['value'];
        }
        if (typeof obj['yearBuilt'] === 'number') {
          details.yearBuilt = obj['yearBuilt'];
        }

        if (Object.keys(details).length > 0) {
          result.details = details;
        }

        return result;
      }
    }
    return null;
  }

  private async extractFromDom(page: Page): Promise<ScrapeResult> {
    const result: ScrapeResult = { status: 'success' };

    // Extract Redfin Estimate or price
    const estimateText = await safeTextContent(page, SELECTORS.redfinEstimate);
    const priceText = await safeTextContent(page, SELECTORS.price);
    const priceSource = estimateText ?? priceText;
    if (priceSource) {
      result.estimatedPrice = parseNumeric(priceSource);
    }

    // Details
    const details: NonNullable<ScrapeResult['details']> = {};
    const bedsText = await safeTextContent(page, SELECTORS.beds);
    if (bedsText) details.beds = parseNumeric(bedsText);
    const bathsText = await safeTextContent(page, SELECTORS.baths);
    if (bathsText) details.baths = parseNumeric(bathsText);
    const sqftText = await safeTextContent(page, SELECTORS.sqft);
    if (sqftText) details.sqft = parseNumeric(sqftText);
    const yearBuiltText = await safeTextContent(page, SELECTORS.yearBuilt);
    if (yearBuiltText) details.yearBuilt = parseNumeric(yearBuiltText);
    const lotSizeText = await safeTextContent(page, SELECTORS.lotSize);
    if (lotSizeText) details.lotSize = lotSizeText;

    if (Object.keys(details).length > 0) {
      result.details = details;
    }

    // Warn with selector probe when no price found
    if (!result.estimatedPrice) {
      const probe = {
        redfinEstimate: await this.probeSelector(page, SELECTORS.redfinEstimate),
        price: await this.probeSelector(page, SELECTORS.price),
      };
      this.logger.warn(
        { site: this.name, url: page.url(), selectorProbe: probe },
        'DIAG: DOM scraping found no price — check these selector alternatives',
      );
    }

    // Price/sales history
    result.salesHistory = await this.extractSalesHistory(page);

    // Tax history
    result.taxHistory = await this.extractTaxHistory(page);

    // Comparables
    result.comparables = await this.extractComparables(page);

    return result;
  }

  private async extractSalesHistory(page: Page): Promise<ScrapeResult['salesHistory']> {
    try {
      return await page.$$eval(SELECTORS.priceHistory, (rows) =>
        rows
          .map((row) => {
            const cells = row.querySelectorAll('td, span, div');
            const texts = Array.from(cells)
              .map((c) => c.textContent?.trim() ?? '')
              .filter(Boolean);
            if (texts.length < 3) return null;
            const date = texts[0] ?? '';
            const event = texts[1] ?? '';
            const priceStr = texts[2] ?? '';
            const price = Number(priceStr.replace(/[^0-9.]/g, ''));
            if (!date || isNaN(price)) return null;
            return { date, price, event };
          })
          .filter((r): r is NonNullable<typeof r> => r !== null),
      );
    } catch {
      return undefined;
    }
  }

  private async extractTaxHistory(page: Page): Promise<ScrapeResult['taxHistory']> {
    try {
      return await page.$$eval(SELECTORS.taxHistory, (rows) =>
        rows
          .map((row) => {
            const cells = row.querySelectorAll('td, span, div');
            const texts = Array.from(cells)
              .map((c) => c.textContent?.trim() ?? '')
              .filter(Boolean);
            if (texts.length < 3) return null;
            const year = parseInt(texts[0] ?? '', 10);
            const tax = Number((texts[1] ?? '').replace(/[^0-9.]/g, ''));
            const assessment = Number((texts[2] ?? '').replace(/[^0-9.]/g, ''));
            if (isNaN(year) || isNaN(tax)) return null;
            return { year, tax, assessment };
          })
          .filter((r): r is NonNullable<typeof r> => r !== null),
      );
    } catch {
      return undefined;
    }
  }

  private async extractComparables(page: Page): Promise<ScrapeResult['comparables']> {
    try {
      return await page.$$eval(SELECTORS.comparables, (rows) =>
        rows
          .map((row) => {
            const addrEl = row.querySelector('.address, .comp-address, a');
            const priceEl = row.querySelector('.price, .comp-price');
            const address = addrEl?.textContent?.trim() ?? '';
            const priceStr = priceEl?.textContent?.trim() ?? '';
            const price = Number(priceStr.replace(/[^0-9.]/g, ''));
            if (!address || isNaN(price)) return null;
            return { address, price };
          })
          .filter((r): r is NonNullable<typeof r> => r !== null),
      );
    } catch {
      return undefined;
    }
  }
}

function parseNumeric(text: string): number {
  return Number(text.replace(/[^0-9.]/g, ''));
}

async function safeTextContent(
  page: Page,
  selector: string,
): Promise<string | null> {
  try {
    const el = await page.$(selector);
    if (!el) return null;
    return (await el.textContent())?.trim() ?? null;
  } catch {
    return null;
  }
}
