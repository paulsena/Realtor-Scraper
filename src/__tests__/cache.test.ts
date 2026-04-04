import { describe, it, expect, beforeEach, vi } from 'vitest';
import { initDatabase } from '../cache/db.js';
import { Cache } from '../cache/cache.js';
import type Database from 'better-sqlite3';

// Mock loadConfig so we don't need API_KEY env var in cache tests
vi.mock('../config.js', () => ({
  loadConfig: () => ({ cacheTtlDays: 14 }),
}));

describe('Cache', () => {
  let db: Database.Database;
  let cache: Cache;

  beforeEach(() => {
    db = initDatabase(':memory:');
    cache = new Cache(db, 14);
  });

  it('returns null for a missing key', () => {
    expect(cache.get('nonexistent')).toBeNull();
  });

  it('stores and retrieves a value', () => {
    const data = { zestimate: 500000, redfin: 510000 };
    cache.set('123 main street', data);
    expect(cache.get('123 main street')).toEqual(data);
  });

  it('overwrites an existing entry on set', () => {
    cache.set('123 main street', { v: 1 });
    cache.set('123 main street', { v: 2 });
    expect(cache.get('123 main street')).toEqual({ v: 2 });
  });

  it('returns null for expired entries', () => {
    // Insert a row with a very old timestamp
    db.prepare(
      'INSERT INTO cache (address, results, created_at) VALUES (?, ?, ?)',
    ).run('old address', JSON.stringify({ v: 1 }), 0);

    expect(cache.get('old address')).toBeNull();
  });

  it('clear() removes expired entries and keeps fresh ones', () => {
    // Fresh entry
    cache.set('fresh', { v: 1 });

    // Expired entry (timestamp = 0)
    db.prepare(
      'INSERT OR REPLACE INTO cache (address, results, created_at) VALUES (?, ?, ?)',
    ).run('expired', JSON.stringify({ v: 2 }), 0);

    const removed = cache.clear();
    expect(removed).toBe(1);

    // Fresh should still be there
    expect(cache.get('fresh')).toEqual({ v: 1 });
    // Expired should be gone
    expect(cache.get('expired')).toBeNull();
  });
});

describe('initDatabase', () => {
  it('creates the cache table', () => {
    const db = initDatabase(':memory:');
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='cache'",
      )
      .all() as Array<{ name: string }>;
    expect(tables).toHaveLength(1);
    expect(tables[0]!.name).toBe('cache');
  });
});
