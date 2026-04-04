import { describe, it, expect, beforeAll } from 'vitest';
import { createApp } from '../server.js';
import { loadConfig } from '../config.js';
import { initDatabase } from '../cache/db.js';
import { Cache } from '../cache/cache.js';
import { initHouseValueRoute } from '../routes/house-value.js';
import { ScraperService } from '../services/scraper-service.js';
import type { Config } from '../config.js';
import type express from 'express';

let app: express.Express;
let config: Config;

beforeAll(() => {
  process.env['API_KEY'] = 'test-api-key';
  config = loadConfig();
  app = createApp(config);
  const db = initDatabase(':memory:');
  const cache = new Cache(db, 14);
  const service = new ScraperService(cache, null as never, [], {
    scrapeTimeoutMs: 5000,
    requestTimeoutMs: 10000,
  });
  initHouseValueRoute(service);
});

async function request(
  app: express.Express,
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  // Use a lightweight approach: start a temporary server
  const { createServer } = await import('node:http');

  return new Promise((resolve, reject) => {
    const server = createServer(app);
    server.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('Failed to get server address'));
        return;
      }
      const port = addr.port;
      const url = `http://127.0.0.1:${port}${path}`;

      fetch(url, { method, headers })
        .then(async (res) => {
          const body = await res.json();
          server.close();
          resolve({ status: res.status, body });
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

async function requestRaw(
  app: express.Express,
  path: string,
): Promise<{ status: number; contentType: string | null }> {
  const { createServer } = await import('node:http');

  return new Promise((resolve, reject) => {
    const server = createServer(app);
    server.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('Failed to get server address'));
        return;
      }
      const port = addr.port;
      fetch(`http://127.0.0.1:${port}${path}`)
        .then((res) => {
          server.close();
          resolve({ status: res.status, contentType: res.headers.get('content-type') });
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

describe('Swagger docs', () => {
  it('GET /api-docs returns HTML without auth', async () => {
    const res = await requestRaw(app, '/api-docs');
    expect(res.status).toBe(200);
    expect(res.contentType).toMatch(/text\/html/);
  });

  it('GET /api-docs/ returns HTML without auth', async () => {
    const res = await requestRaw(app, '/api-docs/');
    expect(res.status).toBe(200);
    expect(res.contentType).toMatch(/text\/html/);
  });
});

describe('Server smoke tests', () => {
  it('GET /health returns 200', async () => {
    const res = await request(app, 'GET', '/health');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status', 'ok');
  });

  it('GET /api/house-value without API key returns 401', async () => {
    const res = await request(app, 'GET', '/api/house-value?address=123+Main+St');
    expect(res.status).toBe(401);
  });

  it('GET /api/house-value with correct API key returns 200', async () => {
    const res = await request(app, 'GET', '/api/house-value?address=123+Main+St', {
      'x-api-key': 'test-api-key',
    });
    expect(res.status).toBe(200);
  });
});
