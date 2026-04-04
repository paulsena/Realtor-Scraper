function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw === 'true' || raw === '1';
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be a number, got: ${raw}`);
  }
  return parsed;
}

export interface Config {
  readonly port: number;
  readonly apiKey: string;
  readonly scrapeTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly scrapers: {
    readonly zillowEnabled: boolean;
    readonly redfinEnabled: boolean;
    readonly realtorEnabled: boolean;
  };
  readonly proxyUrl: string | undefined;
  readonly poolSizePerSite: number;
  readonly contextMaxAgeMs: number;
  readonly contextMaxUses: number;
  readonly cacheTtlDays: number;
  readonly logLevel: string;
  readonly debugScreenshots: boolean;
}

export function loadConfig(): Config {
  return Object.freeze({
    port: intEnv('PORT', 3000),
    apiKey: requiredEnv('API_KEY'),
    scrapeTimeoutMs: intEnv('SCRAPE_TIMEOUT_MS', 60000),
    requestTimeoutMs: intEnv('REQUEST_TIMEOUT_MS', 150000),
    scrapers: Object.freeze({
      zillowEnabled: boolEnv('SCRAPERS_ZILLOW_ENABLED', true),
      redfinEnabled: boolEnv('SCRAPERS_REDFIN_ENABLED', true),
      realtorEnabled: boolEnv('SCRAPERS_REALTOR_ENABLED', true),
    }),
    proxyUrl: process.env['PROXY_URL'] || undefined,
    poolSizePerSite: intEnv('POOL_SIZE_PER_SITE', 2),
    contextMaxAgeMs: intEnv('CONTEXT_MAX_AGE_MS', 1800000),
    contextMaxUses: intEnv('CONTEXT_MAX_USES', 10),
    cacheTtlDays: intEnv('CACHE_TTL_DAYS', 14),
    logLevel: optionalEnv('LOG_LEVEL', 'info'),
    debugScreenshots: boolEnv('DEBUG_SCREENSHOTS', false),
  });
}
