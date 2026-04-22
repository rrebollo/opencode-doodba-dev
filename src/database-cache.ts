import { DoodbaIndexDatabase } from "./database";

interface CacheEntry {
  db: DoodbaIndexDatabase;
  lastUsed: number;
  expiresAt: number;
}

export class DatabaseCache {
  private cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number; // Time-to-live in milliseconds

  constructor(ttlMs = 5 * 60 * 1000) {
    // Default 5 minutes
    this.ttlMs = ttlMs;
  }

  get(path: string): DoodbaIndexDatabase | null {
    const entry = this.cache.get(path);
    if (!entry) return null;

    const now = Date.now();
    if (now > entry.expiresAt) {
      // Expired
      this.cache.delete(path);
      return null;
    }

    // Extend TTL on access
    entry.lastUsed = now;
    entry.expiresAt = now + this.ttlMs;
    return entry.db;
  }

  set(path: string, db: DoodbaIndexDatabase): void {
    const now = Date.now();
    this.cache.set(path, {
      db,
      lastUsed: now,
      expiresAt: now + this.ttlMs,
    });
  }

  has(path: string): boolean {
    return this.get(path) !== null;
  }

  clear(): void {
    this.cache.forEach((entry) => {
      try {
        entry.db.close();
      } catch (e) {
        console.warn(`Failed to close cached database: ${e}`);
      }
    });
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
}

export const globalDatabaseCache = new DatabaseCache();
