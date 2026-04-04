# realtor-scraper

A self-hosted API that scrapes house price estimates from Zillow, Redfin, and Realtor.com. Accepts an address and returns estimated values from each site's proprietary algorithm.

Designed for low-volume personal use (1-3 concurrent users). Runs on Oracle Cloud free tier via Docker Compose.

## Features

- Scrapes Zestimate (Zillow), Redfin Estimate, and Realtor.com estimate in parallel
- Anti-detection stack: patched Playwright, fingerprint injection, human-like mouse/keyboard behavior
- 14-day SQLite cache — repeat requests return instantly
- Address normalization so `"123 Main St"` and `"123 main street"` hit the same cache entry
- Prometheus metrics + Grafana dashboard
- HTTPS via Caddy (auto Let's Encrypt)
- API key authentication

## API

```
GET /api/house-value?address=123+Main+St,+Austin+TX
X-API-Key: <your-key>
```

**Response:**
```json
{
  "address": "123 Main St, Austin TX",
  "normalizedAddress": "123 main street austin tx",
  "cached": false,
  "results": {
    "zillow":  { "status": "success", "estimatedPrice": 450000, "details": { ... } },
    "redfin":  { "status": "success", "estimatedPrice": 438000, "details": { ... } },
    "realtor": { "status": "timeout" }
  },
  "meta": {
    "requestId": "abc-123",
    "durationMs": 12400,
    "timestamp": "2026-04-04T14:00:00.000Z"
  }
}
```

Scraper statuses: `success` | `blocked` | `timeout` | `error`

Other endpoints:
- `GET /health` — liveness check
- `GET /metrics` — Prometheus metrics (no auth required)

## Quick Start

**1. Clone and configure:**
```bash
cp .env.example .env
# Edit .env — set API_KEY at minimum
```

**2. Update the domain in `Caddyfile`:**
```
your-domain.com {
    reverse_proxy app:3000
}
```

**3. Start:**
```bash
docker compose up -d
```

Services:
| Service | URL |
|---------|-----|
| API | `https://your-domain.com` |
| Grafana | `http://your-ip:3001` |
| Prometheus | internal only |

## Configuration

All config is via environment variables (see `.env.example`):

| Variable | Default | Description |
|----------|---------|-------------|
| `API_KEY` | — | **Required.** Secret key for `X-API-Key` header |
| `PORT` | `3000` | App port |
| `SCRAPE_TIMEOUT_MS` | `20000` | Per-site scrape timeout |
| `REQUEST_TIMEOUT_MS` | `30000` | Hard ceiling for the full request |
| `SCRAPERS_ZILLOW_ENABLED` | `true` | Enable/disable Zillow |
| `SCRAPERS_REDFIN_ENABLED` | `true` | Enable/disable Redfin |
| `SCRAPERS_REALTOR_ENABLED` | `true` | Enable/disable Realtor.com |
| `PROXY_URL` | — | Optional HTTP proxy (e.g. `http://user:pass@host:port`) |
| `POOL_SIZE_PER_SITE` | `2` | Browser contexts to keep warm per site |
| `CONTEXT_MAX_AGE_MS` | `1800000` | Max context age before rotation (30 min) |
| `CONTEXT_MAX_USES` | `10` | Max requests per context before rotation |
| `CACHE_TTL_DAYS` | `14` | Cache expiry in days |
| `LOG_LEVEL` | `info` | Pino log level (`debug`, `info`, `warn`, `error`) |
| `DEBUG_SCREENSHOTS` | `false` | Save screenshots on scrape failure |

## Anti-Detection Stack

| Layer | Tool |
|-------|------|
| CDP leak patching | `rebrowser-playwright` |
| Fingerprint spoofing | `fingerprint-generator` + `fingerprint-injector` |
| TLS/JA3 | Real Chrome binary (`channel: 'chrome'`) |
| Mouse movement | `ghost-cursor-playwright` (Bezier curves) |
| Typing | Gaussian keystroke delays (~80ms) |
| Navigation | Search-box flow with Google referrer |
| Viewport | Random from pool of 5 common resolutions |
| Timezone | Random US timezone per context |

## Development

```bash
npm install
cp .env.example .env   # set API_KEY=dev-key

npm run dev            # start with tsx (hot-ish reload)
npm run typecheck      # tsc --noEmit
npm test               # vitest
npm run build          # compile to dist/
```

Google Chrome must be installed locally for `npm run dev` (the Docker image installs it automatically).

## Project Structure

```
src/
├── config.ts                  # Env var parsing
├── index.ts                   # Entry point + graceful shutdown
├── server.ts                  # Express app factory
├── middleware/auth.ts          # X-API-Key authentication
├── routes/
│   ├── house-value.ts          # Main scrape endpoint
│   ├── health.ts
│   └── metrics.ts
├── scrapers/
│   ├── base-scraper.ts         # Common navigation + extraction flow
│   ├── zillow.ts
│   ├── redfin.ts
│   └── realtor.ts
├── stealth/
│   ├── browser.ts              # Singleton Chrome launch
│   ├── context-factory.ts      # Fingerprinted context creation
│   └── human.ts                # Mouse, typing, scroll helpers
├── pool/
│   └── context-pool.ts         # Per-site browser context pool
├── cache/
│   ├── db.ts                   # SQLite init
│   └── cache.ts                # TTL cache get/set/clear
├── normalize/
│   └── address.ts              # Address normalization for cache keys
├── metrics/
│   └── index.ts                # Prometheus metric definitions
└── utils/
    └── logger.ts               # Pino logger
```

## Scraper Debugging

The `scraper-debug/` directory contains standalone diagnostic scripts for testing scrapers outside the full API stack:

| Script | Purpose |
|--------|---------|
| `redfin-myhome.ts` | Full Redfin flow: navigates to what-is-my-home-worth, types address, clicks autocomplete, checks price selectors and JSON-LD |
| `redfin-price-sel.ts` | Discovers price-related DOM elements by walking the page — useful when selectors break after a site redesign |

Run with:
```bash
npx tsx scraper-debug/redfin-myhome.ts
npx tsx scraper-debug/redfin-price-sel.ts
```

Google Chrome must be installed locally. Edit the hardcoded address at the bottom of each file before running.

## Notes

- Selectors in `zillow.ts`, `redfin.ts`, and `realtor.ts` will need empirical tuning against live sites — scrapers use JSON-LD extraction first and fall back to DOM selectors
- Each failed scrape retries once with a fresh browser context before giving up
- The `data/` directory (SQLite file) is persisted via a Docker named volume
