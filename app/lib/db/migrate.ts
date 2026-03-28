import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { logger } from "../logger.js";

export async function runMigrations() {
  const sqlite = new Database(process.env.DATABASE_URL ?? "./data/aisight.db");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite);

  try {
    migrate(db, { migrationsFolder: "./db/migrations" });
    logger.debug("DB migrations check complete (no-op if up to date)");
  } catch (err) {
    logger.error({ err }, "Migration failed");
    throw err;
  } finally {
    sqlite.close();
  }
}
