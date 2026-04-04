import { type BrowserContext, type Page } from 'rebrowser-playwright';
import { loadConfig, type Config } from '../config.js';
import { createStealthContext } from '../stealth/context-factory.js';
import { closeBrowser } from '../stealth/browser.js';
import { contextPoolSize } from '../metrics/index.js';
import type { Scraper } from '../scrapers/types.js';

interface PoolEntry {
  context: BrowserContext;
  createdAt: number;
  useCount: number;
  inUse: boolean;
  /** Pre-navigated landing page, ready for the next scrape. Consumed on acquire. */
  landingPage?: Page;
}

type SiteName = string;

export interface AcquiredContext {
  context: BrowserContext;
  /** Pre-navigated landing page if one was ready, otherwise undefined. */
  landingPage?: Page;
}

export class ContextPool {
  private readonly pools = new Map<SiteName, PoolEntry[]>();
  private readonly config: Config;
  private siteUrls = new Map<SiteName, string>();
  private backgroundInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.config = loadConfig();
  }

  private getPool(site: SiteName): PoolEntry[] {
    let pool = this.pools.get(site);
    if (!pool) {
      pool = [];
      this.pools.set(site, pool);
    }
    return pool;
  }

  private isExpired(entry: PoolEntry): boolean {
    const age = Date.now() - entry.createdAt;
    return age > this.config.contextMaxAgeMs || entry.useCount >= this.config.contextMaxUses;
  }

  private updateGauge(site: SiteName): void {
    const pool = this.getPool(site);
    contextPoolSize.labels(site).set(pool.length);
  }

  async acquire(site: SiteName): Promise<AcquiredContext> {
    const pool = this.getPool(site);

    // Find a free, unexpired context
    const entry = pool.find((e) => !e.inUse && !this.isExpired(e));
    if (entry) {
      entry.inUse = true;
      entry.useCount++;
      this.updateGauge(site);
      // Pop the pre-navigated page so it's not reused
      let landingPage = entry.landingPage;
      entry.landingPage = undefined;
      if (landingPage && landingPage.isClosed()) {
        landingPage = undefined;
      }
      return { context: entry.context, landingPage };
    }

    // Create a new context on demand (no pre-navigated page)
    const context = await createStealthContext();
    const newEntry: PoolEntry = {
      context,
      createdAt: Date.now(),
      useCount: 1,
      inUse: true,
    };
    pool.push(newEntry);
    this.updateGauge(site);
    return { context };
  }

  async release(site: SiteName, context: BrowserContext): Promise<void> {
    const pool = this.getPool(site);
    const entry = pool.find((e) => e.context === context);
    if (!entry) return;

    entry.inUse = false;

    if (this.isExpired(entry)) {
      const idx = pool.indexOf(entry);
      if (idx !== -1) pool.splice(idx, 1);
      this.updateGauge(site);
      void entry.context.close().catch(() => {});

      // Replace with a fresh context, pre-navigated and ready
      void this.createPreloadedEntry(site).then((newEntry) => {
        pool.push(newEntry);
        this.updateGauge(site);
      }).catch(() => {});
    } else {
      // Context is still good — pre-navigate it in the background for next use
      void this.prenavigateEntry(site, entry).catch(() => {});
    }
  }

  async warmUp(scrapers: Scraper[]): Promise<void> {
    // Build site → URL map for background refreshes
    for (const scraper of scrapers) {
      this.siteUrls.set(scraper.name, scraper.landingUrl);
    }

    const promises: Promise<void>[] = [];
    for (const scraper of scrapers) {
      for (let i = 0; i < this.config.poolSizePerSite; i++) {
        promises.push(
          this.createPreloadedEntry(scraper.name).then((entry) => {
            this.getPool(scraper.name).push(entry);
            this.updateGauge(scraper.name);
          }),
        );
      }
    }
    await Promise.all(promises);

    // Start background cleanup interval (60s)
    this.backgroundInterval = setInterval(() => {
      void this.retireExpiredIdle();
    }, 60_000);
  }

  private async createPreloadedEntry(site: SiteName): Promise<PoolEntry> {
    const context = await createStealthContext();
    const entry: PoolEntry = {
      context,
      createdAt: Date.now(),
      useCount: 0,
      inUse: false,
    };
    await this.prenavigateEntry(site, entry);
    return entry;
  }

  private async prenavigateEntry(site: SiteName, entry: PoolEntry): Promise<void> {
    // Realtor.com bot protection aggressively closes pre-navigated connections
    if (site === 'realtor') return;

    const url = this.siteUrls.get(site);
    if (!url) return;
    try {
      const page = await entry.context.newPage();
      await page.setExtraHTTPHeaders({ Referer: 'https://www.google.com/' });
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      entry.landingPage = page;
    } catch {
      // Non-fatal — scraper will navigate normally if no page is available
    }
  }

  private async retireExpiredIdle(): Promise<void> {
    for (const [site, pool] of this.pools) {
      const expiredIdle = pool.filter((e) => !e.inUse && this.isExpired(e));
      for (const entry of expiredIdle) {
        const idx = pool.indexOf(entry);
        if (idx !== -1) pool.splice(idx, 1);
        void entry.context.close().catch(() => {});

        // Replace with a fresh pre-navigated context
        void this.createPreloadedEntry(site).then((newEntry) => {
          pool.push(newEntry);
          this.updateGauge(site);
        }).catch(() => {});
      }
      this.updateGauge(site);
    }
  }

  async shutdown(): Promise<void> {
    if (this.backgroundInterval) {
      clearInterval(this.backgroundInterval);
      this.backgroundInterval = null;
    }

    const closePromises: Promise<void>[] = [];
    for (const [, pool] of this.pools) {
      for (const entry of pool) {
        closePromises.push(entry.context.close().catch(() => {}));
      }
      pool.length = 0;
    }
    await Promise.all(closePromises);
    await closeBrowser();
  }
}
