import Database from 'better-sqlite3';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cache (
  address TEXT PRIMARY KEY,
  results TEXT NOT NULL,
  created_at INTEGER NOT NULL
)
`;

/**
 * Initialize a SQLite database with the cache schema.
 * Pass a custom path or ':memory:' for testing.
 */
export function initDatabase(dbPath?: string): Database.Database {
  const resolvedPath = dbPath ?? path.resolve('data', 'scraper.db');
  const db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}
