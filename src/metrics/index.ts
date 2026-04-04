import client from 'prom-client';

export const register = client.register;

client.collectDefaultMetrics({ register });

export const scrapeRequestsTotal = new client.Counter({
  name: 'scrape_requests_total',
  help: 'Total number of scrape requests',
  labelNames: ['site', 'status'] as const,
  registers: [register],
});

export const scrapeDurationSeconds = new client.Histogram({
  name: 'scrape_duration_seconds',
  help: 'Duration of scrape operations in seconds',
  labelNames: ['site'] as const,
  buckets: [1, 2, 5, 10, 15, 20, 30],
  registers: [register],
});

export const contextPoolSize = new client.Gauge({
  name: 'context_pool_size',
  help: 'Number of browser contexts in the pool',
  labelNames: ['site'] as const,
  registers: [register],
});

export const activeScrapes = new client.Gauge({
  name: 'active_scrapes',
  help: 'Number of currently active scrape operations',
  registers: [register],
});
