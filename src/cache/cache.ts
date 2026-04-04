import type Database from 'better-sqlite3';
import { loadConfig } from '../config.js';

export interface CacheRow {
  address: string;
  results: string;
  created_at: number;
}

export class Cache {
  private readonly db: Database.Database;
  private readonly ttlMs: number;

  constructor(db: Database.Database, ttlDays?: number) {
    this.db = db;
    const days = ttlDays ?? loadConfig().cacheTtlDays;
    this.ttlMs = days * 24 * 60 * 60 * 1000;
  }

  /** Look up a cached entry. Returns parsed JSON or null if missing/expired. */
  get(normalizedAddress: string): unknown | null {
    const row = this.db
      .prepare('SELECT results, created_at FROM cache WHERE address = ?')
      .get(normalizedAddress) as CacheRow | undefined;

    if (!row) return null;

    const age = Date.now() - row.created_at;
    if (age > this.ttlMs) return null;

    try {
      return JSON.parse(row.results) as unknown;
    } catch {
      return null;
    }
  }

  /** Upsert a cache entry with the current timestamp. */
  set(normalizedAddress: string, results: unknown): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO cache (address, results, created_at) VALUES (?, ?, ?)',
      )
      .run(normalizedAddress, JSON.stringify(results), Date.now());
  }

  /** Delete all expired entries. */
  clear(): number {
    const cutoff = Date.now() - this.ttlMs;
    const info = this.db
      .prepare('DELETE FROM cache WHERE created_at < ?')
      .run(cutoff);
    return info.changes;
  }

  /** Remove a specific cache entry by normalized address. */
  delete(normalizedAddress: string): void {
    this.db.prepare('DELETE FROM cache WHERE address = ?').run(normalizedAddress);
  }
}
