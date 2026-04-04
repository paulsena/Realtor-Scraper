import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { createApp } from './server.js';
import { createLogger } from './utils/logger.js';
import { initMetrics } from './metrics/index.js';
import { initDatabase } from './cache/db.js';
import { Cache } from './cache/cache.js';
import { ContextPool } from './pool/context-pool.js';
import { initHouseValueRoute } from './routes/house-value.js';
import { ScraperService } from './services/scraper-service.js';
import { ZillowScraper } from './scrapers/zillow.js';
import { RedfinScraper } from './scrapers/redfin.js';
import { RealtorScraper } from './scrapers/realtor.js';

dotenv.config();

const config = loadConfig();
const logger = createLogger(config.logLevel);

async function main(): Promise<void> {
  initMetrics();

  // Ensure data directory exists for SQLite
  const dataDir = path.resolve('data');
  fs.mkdirSync(dataDir, { recursive: true });

  // Initialize SQLite
  const db = initDatabase();
  const cache = new Cache(db, config.cacheTtlDays);
  logger.info('SQLite database initialized');

  // Initialize context pool and warm up
  const pool = new ContextPool();
  logger.info('Warming up context pool...');
  await pool.warmUp();
  logger.info('Context pool warmed up');

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

  // Create and start server
  const app = createApp(config);
  const server = app.listen(config.port, () => {
    logger.info({ port: config.port }, 'Server started');
  });

  // Track in-flight requests
  let inFlightRequests = 0;
  const originalListeners = server.listeners('request');

  // Wrap request tracking
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    inFlightRequests++;
    res.on('finish', () => {
      inFlightRequests--;
    });
    // Forward to Express
    for (const listener of originalListeners) {
      (listener as (...args: unknown[]) => void)(req, res);
    }
  });

  // Graceful shutdown
  async function shutdown(signal: string): Promise<void> {
    logger.info({ signal }, 'Received shutdown signal — stopping new connections');

    // Stop accepting new connections
    server.close(() => {
      logger.info('HTTP server closed');
    });

    // Wait for in-flight requests (up to 30s)
    const shutdownDeadline = Date.now() + 30_000;
    while (inFlightRequests > 0 && Date.now() < shutdownDeadline) {
      logger.info({ inFlightRequests }, 'Waiting for in-flight requests to complete');
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    if (inFlightRequests > 0) {
      logger.warn({ inFlightRequests }, 'Forcing shutdown with in-flight requests still pending');
    }

    // Close pool (which also closes the browser)
    logger.info('Shutting down context pool...');
    await pool.shutdown();
    logger.info('Context pool shut down');

    // Close SQLite
    db.close();
    logger.info('SQLite database closed');

    process.exit(0);
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'Fatal error during startup');
  process.exit(1);
});
