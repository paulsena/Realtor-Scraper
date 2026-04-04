import type { BrowserContext, Page } from 'rebrowser-playwright';
import type { ScrapeResult, Scraper } from './types.js';
import {
  navigateWithReferrer,
  gaussianDelay,
  humanClick,
  humanType,
} from '../stealth/human.js';
import { loadConfig } from '../config.js';
import { createLogger } from '../utils/logger.js';
import type pino from 'pino';

const CAPTCHA_INDICATORS = [
  'iframe[src*="captcha"]',
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  'div[class*="challenge"]',
  'div[id*="captcha"]',
  'div[class*="captcha"]',
  '#px-captcha',
  '#cf-challenge-running',
];

const COOKIE_BANNER_SELECTORS = [
  'button[id*="cookie-accept"]',
  'button[class*="cookie-accept"]',
  'button[aria-label*="Accept"]',
  'button[data-testid*="cookie"]',
  '#onetrust-accept-btn-handler',
  'button.accept-cookies',
];

export interface ScraperSelectors {
  readonly searchBox: string;
  readonly autocompleteResult: string;
  readonly priceSelector: string;
}

export abstract class BaseScraper implements Scraper {
  abstract readonly name: string;
  abstract readonly landingUrl: string;
  protected abstract readonly selectors: ScraperSelectors;
  protected readonly logger: pino.Logger;

  constructor(logger?: pino.Logger) {
    this.logger = logger ?? createLogger('info');
  }

  protected abstract extractData(page: Page): Promise<ScrapeResult>;

  async scrape(
    context: BrowserContext,
    address: string,
    timeoutMs: number,
    landingPage?: Page,
  ): Promise<ScrapeResult> {
    const timeoutPromise = new Promise<ScrapeResult>((resolve) => {
      setTimeout(() => resolve({ status: 'timeout' }), timeoutMs);
    });

    const scrapePromise = this.doScrape(context, address, landingPage);

    return Promise.race([scrapePromise, timeoutPromise]);
  }

  private async doScrape(
    context: BrowserContext,
    address: string,
    preloadedPage?: Page,
  ): Promise<ScrapeResult> {
    const site = this.name;
    let page: Page | undefined;
    try {
      if (preloadedPage) {
        page = preloadedPage;
        this.logger.info({ site, address }, 'Using pre-navigated landing page');
      } else {
        page = await context.newPage();
        this.logger.info({ site, address }, 'Navigating to landing page');
        await navigateWithReferrer(page, this.landingUrl);
        this.logger.info({ site }, 'Landing page loaded, waiting before interaction');
        // Gaussian delay 2-4s only when we navigated fresh — simulates reading the page
        await gaussianDelay(page, 3000, 500);
      }

      // Dismiss cookie banners if present
      await this.dismissCookieBanner(page);

      // Check for bot detection before interacting
      const blocked = await this.detectBlock(page);
      if (blocked) {
        this.logger.warn({ site, address }, 'Bot detection triggered on landing page');
        await this.screenshotOnDebug(page, 'blocked');
        return { status: 'blocked', error: 'Bot detection triggered on landing page' };
      }

      const directUrl = this.getDirectPropertyUrl(address);
      if (directUrl) {
        // Direct URL strategy: navigate straight to the property page
        this.logger.info({ site, address, url: directUrl }, 'Navigating directly to property URL');
        await page.goto(directUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await gaussianDelay(page, 2000, 400);

        // Check for blocks on the direct URL
        const blockedDirect = await this.detectBlock(page);
        if (blockedDirect) {
          this.logger.warn({ site, address }, 'Bot detection triggered on direct property URL');
          await this.screenshotOnDebug(page, 'blocked-direct');
          return { status: 'blocked', error: 'Bot detection triggered on direct property URL' };
        }

        this.logger.info({ site, address }, 'Waiting for property page to load');
        try {
          await page.waitForSelector(this.selectors.priceSelector, { timeout: 15000 });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const diag = await this.getPageDiagnostics(page);
          const selectorProbe = await this.probeSelector(page, this.selectors.priceSelector);
          this.logger.error(
            { site, address, err: msg, selector: this.selectors.priceSelector, selectorProbe, ...diag },
            'DIAG: Property page price element not found after direct navigation',
          );
          throw err;
        }
      } else {
        // Autocomplete strategy: type address in search box and pick first suggestion
        this.logger.info({ site, address }, 'Typing address into search box');
        try {
          await humanClick(page, this.selectors.searchBox);
          await humanType(page, this.selectors.searchBox, address);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const diag = await this.getPageDiagnostics(page);
          const selectorProbe = await this.probeSelector(page, this.selectors.searchBox);
          this.logger.error(
            { site, address, err: msg, selector: this.selectors.searchBox, selectorProbe, ...diag },
            'DIAG: Failed to interact with search box — selector likely outdated',
          );
          throw err;
        }

        this.logger.info({ site, address }, 'Waiting for autocomplete results');
        try {
          await page.waitForSelector(this.selectors.autocompleteResult, {
            timeout: 8000,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const diag = await this.getPageDiagnostics(page);
          const selectorProbe = await this.probeSelector(page, this.selectors.autocompleteResult);
          this.logger.error(
            { site, address, err: msg, selector: this.selectors.autocompleteResult, selectorProbe, ...diag },
            'DIAG: Autocomplete did not appear — selector outdated or search typed incorrectly',
          );
          throw err;
        }
        await gaussianDelay(page, 800, 200);

        this.logger.info({ site, address }, 'Clicking first autocomplete result');
        await humanClick(page, this.selectors.autocompleteResult);

        this.logger.info({ site, address }, 'Waiting for property page to load');
        try {
          await page.waitForSelector(this.selectors.priceSelector, {
            timeout: 15000,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const diag = await this.getPageDiagnostics(page);
          const selectorProbe = await this.probeSelector(page, this.selectors.priceSelector);
          this.logger.error(
            { site, address, err: msg, selector: this.selectors.priceSelector, selectorProbe, ...diag },
            'DIAG: Property page price element not found — wrong page loaded or price selector outdated',
          );
          throw err;
        }
      }

      // Check for blocks on the result page
      const blockedOnResult = await this.detectBlock(page);
      if (blockedOnResult) {
        this.logger.warn({ site, address }, 'Bot detection triggered on property page');
        await this.screenshotOnDebug(page, 'blocked-result');
        return { status: 'blocked', error: 'Bot detection triggered on result page' };
      }

      this.logger.info({ site, address }, 'Extracting property data');
      const result = await this.extractData(page);
      this.logger.info({ site, address, status: result.status }, 'Scrape complete');
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const diag = page ? await this.getPageDiagnostics(page).catch(() => null) : null;
      this.logger.error({ site, address, err: message, ...(diag ?? {}) }, 'Scrape failed with error');
      if (page) {
        await this.screenshotOnDebug(page, 'error');
      }
      return { status: 'error', error: message };
    } finally {
      if (page) {
        await page.close().catch(() => {});
      }
    }
  }

  private async dismissCookieBanner(page: Page): Promise<void> {
    for (const selector of COOKIE_BANNER_SELECTORS) {
      try {
        const el = await page.$(selector);
        if (el) {
          await el.click();
          await gaussianDelay(page, 500, 150);
          return;
        }
      } catch {
        // ignore — banner may not exist
      }
    }
  }

  protected async detectBlock(page: Page): Promise<boolean> {
    for (const selector of CAPTCHA_INDICATORS) {
      try {
        const el = await page.$(selector);
        if (el) return true;
      } catch {
        // ignore
      }
    }
    // Also check page title for access-denied patterns (PerimeterX, CloudFront 403, etc.)
    try {
      const title = await page.title();
      const lc = title.toLowerCase();
      if (
        lc.includes('access to this page has been denied') ||
        lc.includes('access denied') ||
        lc.includes('error: the request could not be satisfied') ||
        lc === '403 error' ||
        lc === '403'
      ) {
        return true;
      }
    } catch {
      // ignore
    }
    return false;
  }

  /**
   * Override in subclasses to provide a direct property URL instead of using
   * the homepage search box + autocomplete flow.
   * Return null to use the default autocomplete-based navigation.
   */
  protected getDirectPropertyUrl(_address: string): string | null {
    return null;
  }

  protected async screenshotOnDebug(
    page: Page,
    label: string,
  ): Promise<void> {
    const config = loadConfig();
    if (!config.debugScreenshots) return;
    const ts = Date.now();
    const safeName = this.name.replace(/[^a-z0-9]/gi, '-');
    await page
      .screenshot({ path: `debug-${safeName}-${label}-${ts}.png` })
      .catch(() => {});
  }

  /**
   * Snapshot current page state for diagnostic logging.
   */
  protected async getPageDiagnostics(
    page: Page,
  ): Promise<{ url: string; pageTitle: string; bodySnippet: string }> {
    const url = page.url();
    const pageTitle = await page.title().catch(() => '(error)');
    const bodySnippet = await page
      .evaluate(() => (document.body?.innerText ?? '').slice(0, 600))
      .catch(() => '(error)');
    return { url, pageTitle, bodySnippet };
  }

  /**
   * For each comma-separated alternative in a compound selector, report whether
   * it matches at least one element — helps pinpoint which alternatives are stale.
   */
  protected async probeSelector(
    page: Page,
    selector: string,
  ): Promise<Record<string, boolean>> {
    const alternatives = selector
      .split(',')
      .map((s) => s.split('>>')[0].trim())
      .filter(Boolean);
    const results: Record<string, boolean> = {};
    for (const alt of alternatives) {
      try {
        results[alt] = (await page.$(alt)) !== null;
      } catch {
        results[alt] = false;
      }
    }
    return results;
  }

  /**
   * Extract JSON-LD data from the page. Returns null if not found or invalid.
   */
  protected async extractJsonLd(page: Page): Promise<unknown[] | null> {
    try {
      const results = await page.evaluate(() => {
        const scripts = document.querySelectorAll(
          'script[type="application/ld+json"]',
        );
        const parsed: unknown[] = [];
        scripts.forEach((s) => {
          try {
            parsed.push(JSON.parse(s.textContent ?? ''));
          } catch {
            // skip invalid JSON
          }
        });
        return parsed;
      });
      return results.length > 0 ? results : null;
    } catch {
      return null;
    }
  }
}
