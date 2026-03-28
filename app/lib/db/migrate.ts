import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { pino } from "pino";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

export async function runMigrations() {
  const sqlite = new Database(process.env.DATABASE_URL ?? "./aisight.db");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite);

  try {
    migrate(db, { migrationsFolder: "./db/migrations" });
    logger.info("Database migrations applied");
  } catch (err) {
    logger.error({ err }, "Migration failed");
    throw err;
  } finally {
    sqlite.close();
  }
}
