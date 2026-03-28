import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

// Singleton — one connection per Node.js process (safe with Remix + Express)
let _db: ReturnType<typeof drizzle> | undefined;

export function getDb() {
  if (!_db) {
    const sqlite = new Database(process.env.DATABASE_URL ?? "./data/aisight.db");
    // Enable WAL mode for better concurrent read performance
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    _db = drizzle(sqlite, { schema });
  }
  return _db;
}
