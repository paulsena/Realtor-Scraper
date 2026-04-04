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
  protected abstract readonly landingUrl: string;
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
  ): Promise<ScrapeResult> {
    const timeoutPromise = new Promise<ScrapeResult>((resolve) => {
      setTimeout(() => resolve({ status: 'timeout' }), timeoutMs);
    });

    const scrapePromise = this.doScrape(context, address);

    return Promise.race([scrapePromise, timeoutPromise]);
  }

  private async doScrape(
    context: BrowserContext,
    address: string,
  ): Promise<ScrapeResult> {
    const site = this.name;
    let page: Page | undefined;
    try {
      page = await context.newPage();

      this.logger.info({ site, address }, 'Navigating to landing page');
      await navigateWithReferrer(page, this.landingUrl);
      this.logger.info({ site }, 'Landing page loaded, waiting before interaction');

      // Gaussian delay 2-4s (mean=3000, stddev=500)
      await gaussianDelay(page, 3000, 500);

      // Dismiss cookie banners if present
      await this.dismissCookieBanner(page);

      // Check for bot detection before interacting
      const blocked = await this.detectBlock(page);
      if (blocked) {
        this.logger.warn({ site, address }, 'Bot detection triggered on landing page');
        await this.screenshotOnDebug(page, 'blocked');
        return { status: 'blocked', error: 'Bot detection triggered on landing page' };
      }

      this.logger.info({ site, address }, 'Typing address into search box');
      await humanClick(page, this.selectors.searchBox);
      await humanType(page, this.selectors.searchBox, address);

      this.logger.info({ site, address }, 'Waiting for autocomplete results');
      await page.waitForSelector(this.selectors.autocompleteResult, {
        timeout: 8000,
      });
      await gaussianDelay(page, 800, 200);

      this.logger.info({ site, address }, 'Clicking first autocomplete result');
      await humanClick(page, this.selectors.autocompleteResult);

      this.logger.info({ site, address }, 'Waiting for property page to load');
      await page.waitForSelector(this.selectors.priceSelector, {
        timeout: 15000,
      });

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
      this.logger.error({ site, address, err: message }, 'Scrape failed with error');
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
    return false;
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
