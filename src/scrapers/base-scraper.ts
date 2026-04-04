import type { BrowserContext, Page } from 'rebrowser-playwright';
import type { ScrapeResult, Scraper } from './types.js';
import {
  navigateWithReferrer,
  gaussianDelay,
  humanClick,
  humanType,
} from '../stealth/human.js';
import { loadConfig } from '../config.js';

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
    let page: Page | undefined;
    try {
      page = await context.newPage();

      // Navigate with Google referrer
      await navigateWithReferrer(page, this.landingUrl);

      // Gaussian delay 2-4s (mean=3000, stddev=500)
      await gaussianDelay(page, 3000, 500);

      // Dismiss cookie banners if present
      await this.dismissCookieBanner(page);

      // Check for bot detection before interacting
      const blocked = await this.detectBlock(page);
      if (blocked) {
        await this.screenshotOnDebug(page, 'blocked');
        return { status: 'blocked', error: 'Bot detection triggered on landing page' };
      }

      // Click search box and type address
      await humanClick(page, this.selectors.searchBox);
      await humanType(page, this.selectors.searchBox, address);

      // Wait for autocomplete results
      await page.waitForSelector(this.selectors.autocompleteResult, {
        timeout: 8000,
      });
      await gaussianDelay(page, 800, 200);

      // Click first autocomplete result
      await humanClick(page, this.selectors.autocompleteResult);

      // Wait for result page with price selector
      await page.waitForSelector(this.selectors.priceSelector, {
        timeout: 15000,
      });

      // Check for blocks on the result page
      const blockedOnResult = await this.detectBlock(page);
      if (blockedOnResult) {
        await this.screenshotOnDebug(page, 'blocked-result');
        return { status: 'blocked', error: 'Bot detection triggered on result page' };
      }

      // Extract data (subclass implements)
      return await this.extractData(page);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
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
