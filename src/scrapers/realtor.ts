import type { Page } from 'rebrowser-playwright';
import { BaseScraper, type ScraperSelectors } from './base-scraper.js';
import type { ScrapeResult } from './types.js';
import type pino from 'pino';

const SELECTORS = {
  searchBox:
    'input[data-testid="freeTypeInput"], input[placeholder*="Search"], input[data-testid="search-bar-input"], input#rdc-search-form-input',
  autocompleteResult:
    '[data-testid="suggestion-item"] >> nth=0, .search-suggestion >> nth=0, [data-testid="search-results-list"] li >> nth=0',
  price:
    '[data-testid="list-price"], .price-section .price, .summary-price',
  estimate:
    '[data-testid="home-value-estimate"], .home-estimate .value, .estimated-value',
  beds: '[data-testid="property-meta-beds"], .property-meta .meta-beds, .summary-beds',
  baths:
    '[data-testid="property-meta-baths"], .property-meta .meta-baths, .summary-baths',
  sqft: '[data-testid="property-meta-sqft"], .property-meta .meta-sqft, .summary-sqft',
  yearBuilt: '[data-testid="year-built"] .value, .property-year-built',
  lotSize: '[data-testid="lot-size"] .value, .property-lot-size',
  priceHistory:
    '[data-testid="price-history-row"], .property-history-row',
  taxHistory:
    '[data-testid="tax-history-row"], .tax-history-row',
} as const;

export class RealtorScraper extends BaseScraper {
  readonly name = 'realtor';

  constructor(logger?: pino.Logger) {
    super(logger);
  }
  readonly landingUrl = 'https://www.realtor.com/';
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

    // Try __NEXT_DATA__ / __PRELOADED_STATE__ extraction
    const nextDataResult = await this.extractFromNextData(page);
    if (nextDataResult) return nextDataResult;

    // Fallback: DOM scraping
    return this.extractFromDom(page);
  }

  protected async detectBlock(page: Page): Promise<boolean> {
    const baseBlocked = await super.detectBlock(page);
    if (baseBlocked) return true;

    // Kasada anti-bot challenge
    try {
      const kasadaScript = await page.$('script[src*="ips.js"]');
      if (kasadaScript) return true;

      const bodyText = await page.textContent('body');
      if (
        bodyText &&
        bodyText.includes('Your request could not be processed') &&
        bodyText.includes('Reference ID')
      ) {
        return true;
      }
    } catch {
      // ignore
    }
    return false;
  }

  private parseJsonLd(data: unknown[]): ScrapeResult | null {
    for (const item of data) {
      if (typeof item !== 'object' || item === null || !('@type' in item)) {
        continue;
      }
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
    return null;
  }

  private async extractFromNextData(page: Page): Promise<ScrapeResult | null> {
    try {
      const data = await page.evaluate(() => {
        // Try __NEXT_DATA__
        const nextDataScript = document.querySelector(
          'script#__NEXT_DATA__',
        );
        if (nextDataScript?.textContent) {
          try {
            return { source: 'next', data: JSON.parse(nextDataScript.textContent) };
          } catch {
            // ignore
          }
        }
        // Try __PRELOADED_STATE__
        const w = window as unknown as Record<string, unknown>;
        if (w['__PRELOADED_STATE__']) {
          return { source: 'preloaded', data: w['__PRELOADED_STATE__'] };
        }
        return null;
      });

      if (!data) return null;

      return this.parseNextData(data.data as Record<string, unknown>);
    } catch {
      return null;
    }
  }

  private parseNextData(data: Record<string, unknown>): ScrapeResult | null {
    try {
      // Navigate through Next.js data structure to find property info
      const props = data['props'] as Record<string, unknown> | undefined;
      const pageProps = (props?.['pageProps'] ?? data['pageProps']) as
        | Record<string, unknown>
        | undefined;
      if (!pageProps) return null;

      // Realtor.com often stores property data under various keys
      const property = (pageProps['property'] ??
        pageProps['listing'] ??
        pageProps['homeDetails']) as Record<string, unknown> | undefined;
      if (!property) return null;

      const result: ScrapeResult = { status: 'success' };

      // Price
      const listPrice = property['list_price'] ?? property['price'] ?? property['estimatedValue'];
      if (typeof listPrice === 'number') {
        result.estimatedPrice = listPrice;
      } else if (typeof listPrice === 'string') {
        result.estimatedPrice = parseNumeric(listPrice);
      }

      // Details
      const details: NonNullable<ScrapeResult['details']> = {};
      const description = property['description'] as Record<string, unknown> | undefined;

      const beds = description?.['beds'] ?? property['beds'];
      if (typeof beds === 'number') details.beds = beds;

      const baths = description?.['baths'] ?? property['baths'];
      if (typeof baths === 'number') details.baths = baths;

      const sqft = description?.['sqft'] ?? property['sqft'];
      if (typeof sqft === 'number') details.sqft = sqft;

      const yearBuilt = description?.['year_built'] ?? property['year_built'];
      if (typeof yearBuilt === 'number') details.yearBuilt = yearBuilt;

      const lotSize = description?.['lot_sqft'] ?? property['lot_sqft'];
      if (typeof lotSize === 'number') {
        details.lotSize = `${lotSize} sqft`;
      } else if (typeof lotSize === 'string') {
        details.lotSize = lotSize;
      }

      if (Object.keys(details).length > 0) {
        result.details = details;
      }

      // Sales history
      const history = property['property_history'] as
        | Array<Record<string, unknown>>
        | undefined;
      if (Array.isArray(history)) {
        result.salesHistory = history
          .map((h) => {
            const date = String(h['date'] ?? '');
            const price = typeof h['price'] === 'number' ? h['price'] : 0;
            const event = String(h['event_name'] ?? h['event'] ?? '');
            if (!date || !price) return null;
            return { date, price, event };
          })
          .filter((r): r is NonNullable<typeof r> => r !== null);
      }

      // Tax history
      const taxHistory = property['tax_history'] as
        | Array<Record<string, unknown>>
        | undefined;
      if (Array.isArray(taxHistory)) {
        result.taxHistory = taxHistory
          .map((t) => {
            const year = typeof t['year'] === 'number' ? t['year'] : 0;
            const tax = typeof t['tax'] === 'number' ? t['tax'] : 0;
            const assessmentObj = t['assessment'] as
              | Record<string, unknown>
              | number
              | undefined;
            const assessment =
              typeof assessmentObj === 'object' &&
              assessmentObj !== null &&
              typeof assessmentObj['total'] === 'number'
                ? assessmentObj['total']
                : typeof assessmentObj === 'number'
                  ? assessmentObj
                  : 0;
            if (!year) return null;
            return { year, tax, assessment };
          })
          .filter((r): r is NonNullable<typeof r> => r !== null);
      }

      return result;
    } catch {
      return null;
    }
  }

  private async extractFromDom(page: Page): Promise<ScrapeResult> {
    const result: ScrapeResult = { status: 'success' };

    // Extract estimate or price
    const estimateText = await safeTextContent(page, SELECTORS.estimate);
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

    // Price history
    result.salesHistory = await this.extractSalesHistory(page);

    // Tax history
    result.taxHistory = await this.extractTaxHistory(page);

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
