import type { Page } from 'rebrowser-playwright';
import { BaseScraper, type ScraperSelectors } from './base-scraper.js';
import type { ScrapeResult } from './types.js';
import type pino from 'pino';

const SELECTORS = {
  searchBox: 'input[type="text"][aria-label*="Search"], input[id="search-box-input"]',
  autocompleteResult:
    'ul[role="listbox"] li[role="option"] >> nth=0',
  price:
    'span[data-testid="price"], .ds-summary-row .ds-value, .home-summary-row span[data-testid="price"]',
  zestimate:
    'span[data-testid="zestimate-text"], .zestimate span.value, [data-testid="zestimate"]',
  beds: 'span[data-testid="bed-bath-item"]:nth-child(1) strong, .ds-bed-bath-living-area span:nth-child(1)',
  baths:
    'span[data-testid="bed-bath-item"]:nth-child(2) strong, .ds-bed-bath-living-area span:nth-child(2)',
  sqft: 'span[data-testid="bed-bath-item"]:nth-child(3) strong, .ds-bed-bath-living-area span:nth-child(3)',
  yearBuilt: '.hdp-facts-list li:has(span:text("Year Built")) span.hdp-fact-value',
  lotSize: '.hdp-facts-list li:has(span:text("Lot Size")) span.hdp-fact-value',
  priceHistory:
    '#price-history table tbody tr, [data-testid="price-history"] table tbody tr',
  taxHistory:
    '#tax-history table tbody tr, [data-testid="tax-history"] table tbody tr',
  comparables:
    '[data-testid="comps-card"], .comps-card, .comparable-card',
} as const;

export class ZillowScraper extends BaseScraper {
  readonly name = 'zillow';

  constructor(logger?: pino.Logger) {
    super(logger);
  }
  readonly landingUrl = 'https://www.zillow.com/';
  protected readonly selectors: ScraperSelectors = {
    searchBox: SELECTORS.searchBox,
    autocompleteResult: SELECTORS.autocompleteResult,
    priceSelector: SELECTORS.price,
  };

  protected async extractData(page: Page): Promise<ScrapeResult> {
    // JSON-LD first strategy
    const jsonLd = await this.extractJsonLd(page);
    if (jsonLd) {
      const result = this.parseJsonLd(jsonLd);
      if (result) return result;
    }

    // Fallback: DOM scraping
    return this.extractFromDom(page);
  }

  private parseJsonLd(data: unknown[]): ScrapeResult | null {
    for (const item of data) {
      if (
        typeof item === 'object' &&
        item !== null &&
        '@type' in item &&
        (item as Record<string, unknown>)['@type'] === 'SingleFamilyResidence'
      ) {
        const obj = item as Record<string, unknown>;
        const result: ScrapeResult = { status: 'success' };

        // Extract price from floorSize/price fields
        if (typeof obj['price'] === 'string' || typeof obj['price'] === 'number') {
          result.estimatedPrice = parseNumeric(String(obj['price']));
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

    // Extract Zestimate or price
    const zestimateText = await safeTextContent(page, SELECTORS.zestimate);
    const priceText = await safeTextContent(page, SELECTORS.price);
    const priceSource = zestimateText ?? priceText;
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

    if (Object.keys(details).length > 0) {
      result.details = details;
    }

    // Price history
    result.salesHistory = await this.extractPriceHistory(page);

    // Tax history
    result.taxHistory = await this.extractTaxHistory(page);

    return result;
  }

  private async extractPriceHistory(page: Page): Promise<ScrapeResult['salesHistory']> {
    try {
      return await page.$$eval(SELECTORS.priceHistory, (rows) =>
        rows
          .map((row) => {
            const cells = row.querySelectorAll('td');
            if (cells.length < 3) return null;
            const date = cells[0]?.textContent?.trim() ?? '';
            const event = cells[1]?.textContent?.trim() ?? '';
            const priceStr = cells[2]?.textContent?.trim() ?? '';
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
            const cells = row.querySelectorAll('td');
            if (cells.length < 3) return null;
            const yearStr = cells[0]?.textContent?.trim() ?? '';
            const taxStr = cells[1]?.textContent?.trim() ?? '';
            const assessStr = cells[2]?.textContent?.trim() ?? '';
            const year = parseInt(yearStr, 10);
            const tax = Number(taxStr.replace(/[^0-9.]/g, ''));
            const assessment = Number(assessStr.replace(/[^0-9.]/g, ''));
            if (isNaN(year) || isNaN(tax)) return null;
            return { year, tax, assessment };
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
