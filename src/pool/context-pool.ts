import { type BrowserContext } from 'rebrowser-playwright';
import { loadConfig, type Config } from '../config.js';
import { createStealthContext } from '../stealth/context-factory.js';
import { closeBrowser } from '../stealth/browser.js';
import { contextPoolSize } from '../metrics/index.js';

interface PoolEntry {
  context: BrowserContext;
  createdAt: number;
  useCount: number;
  inUse: boolean;
}

type SiteName = string;

export class ContextPool {
  private readonly pools = new Map<SiteName, PoolEntry[]>();
  private readonly config: Config;
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

  async acquire(site: SiteName): Promise<BrowserContext> {
    const pool = this.getPool(site);

    // Find a free, unexpired context
    const entry = pool.find((e) => !e.inUse && !this.isExpired(e));
    if (entry) {
      entry.inUse = true;
      entry.useCount++;
      this.updateGauge(site);
      return entry.context;
    }

    // Create a new context
    const context = await createStealthContext();
    const newEntry: PoolEntry = {
      context,
      createdAt: Date.now(),
      useCount: 1,
      inUse: true,
    };
    pool.push(newEntry);
    this.updateGauge(site);
    return context;
  }

  async release(site: SiteName, context: BrowserContext): Promise<void> {
    const pool = this.getPool(site);
    const entry = pool.find((e) => e.context === context);
    if (!entry) return;

    entry.inUse = false;

    if (this.isExpired(entry)) {
      // Remove and close expired context, replace async
      const idx = pool.indexOf(entry);
      if (idx !== -1) pool.splice(idx, 1);
      this.updateGauge(site);

      void entry.context.close().catch(() => {});

      // Replace with a fresh context in the background
      void createStealthContext()
        .then((newCtx) => {
          pool.push({
            context: newCtx,
            createdAt: Date.now(),
            useCount: 0,
            inUse: false,
          });
          this.updateGauge(site);
        })
        .catch(() => {});
    }
  }

  async warmUp(): Promise<void> {
    const scrapers = this.config.scrapers;
    const sites: SiteName[] = [];
    if (scrapers.zillowEnabled) sites.push('zillow');
    if (scrapers.redfinEnabled) sites.push('redfin');
    if (scrapers.realtorEnabled) sites.push('realtor');

    const promises: Promise<void>[] = [];
    for (const site of sites) {
      for (let i = 0; i < this.config.poolSizePerSite; i++) {
        promises.push(
          createStealthContext().then((ctx) => {
            this.getPool(site).push({
              context: ctx,
              createdAt: Date.now(),
              useCount: 0,
              inUse: false,
            });
            this.updateGauge(site);
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

  private async retireExpiredIdle(): Promise<void> {
    for (const [site, pool] of this.pools) {
      const expiredIdle = pool.filter((e) => !e.inUse && this.isExpired(e));
      for (const entry of expiredIdle) {
        const idx = pool.indexOf(entry);
        if (idx !== -1) pool.splice(idx, 1);
        void entry.context.close().catch(() => {});
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
