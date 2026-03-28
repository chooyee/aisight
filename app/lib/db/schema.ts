import { sql } from "drizzle-orm";
import {
  integer,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

// ── Core content ──────────────────────────────────────────────────────────────

export const articles = sqliteTable("articles", {
  id: text("id").primaryKey(),
  url: text("url").notNull().unique(),
  urlHash: text("url_hash").notNull(),
  title: text("title"),
  content: text("content"),
  publishedAt: integer("published_at", { mode: "timestamp" }),
  scrapedAt: integer("scraped_at", { mode: "timestamp" }).notNull(),
  source: text("source").notNull(), // 'tavily' | 'readability' | 'playwright'
  sector: text("sector"),
  language: text("language"),
  riskScore: real("risk_score"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const entities = sqliteTable("entities", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(), // 'company' | 'regulator' | 'person' | 'instrument'
  sector: text("sector"),
  country: text("country"),
  firstSeenAt: integer("first_seen_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const articleEntities = sqliteTable("article_entities", {
  id: text("id").primaryKey(),
  articleId: text("article_id")
    .notNull()
    .references(() => articles.id, { onDelete: "cascade" }),
  entityId: text("entity_id")
    .notNull()
    .references(() => entities.id, { onDelete: "cascade" }),
  confidence: real("confidence").default(1.0),
  context: text("context"),
});

export const relationships = sqliteTable("relationships", {
  id: text("id").primaryKey(),
  fromEntityId: text("from_entity_id")
    .notNull()
    .references(() => entities.id, { onDelete: "cascade" }),
  toEntityId: text("to_entity_id")
    .notNull()
    .references(() => entities.id, { onDelete: "cascade" }),
  relationshipType: text("relationship_type").notNull(), // 'regulated_by' | 'acquired' | 'competes_with' | 'investigated_by'
  weight: real("weight").default(1.0),
  articleId: text("article_id").references(() => articles.id),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const events = sqliteTable("events", {
  id: text("id").primaryKey(),
  articleId: text("article_id")
    .notNull()
    .references(() => articles.id, { onDelete: "cascade" }),
  description: text("description"),
  eventType: text("event_type"),
  occurredAt: integer("occurred_at", { mode: "timestamp" }),
  metricsJson: text("metrics_json"), // JSON blob for numeric values (CET1 ratio, etc.)
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const riskSignals = sqliteTable("risk_signals", {
  id: text("id").primaryKey(),
  eventId: text("event_id")
    .notNull()
    .references(() => events.id, { onDelete: "cascade" }),
  entityId: text("entity_id").references(() => entities.id),
  riskType: text("risk_type").notNull(), // e.g. 'Capital Adequacy', 'Asset Quality'
  category: text("category"), // e.g. 'Basel Pillar 1'
  severity: text("severity"), // 'low' | 'medium' | 'high'
  direction: text("direction"), // 'positive' | 'negative' | 'neutral'
  rationale: text("rationale"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

// ── Pipeline state ─────────────────────────────────────────────────────────────

export const pipelineRuns = sqliteTable("pipeline_runs", {
  id: text("id").primaryKey(),
  sessionId: text("session_id"),
  status: text("status").notNull().default("pending"), // 'pending' | 'running' | 'complete' | 'error'
  query: text("query"),
  progress: text("progress"), // JSON blob with per-stage detail
  itemsTotal: integer("items_total").default(0),
  itemsCompleted: integer("items_completed").default(0),
  startedAt: integer("started_at", { mode: "timestamp" }),
  completedAt: integer("completed_at", { mode: "timestamp" }),
  errorMessage: text("error_message"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const pipelineItems = sqliteTable("pipeline_items", {
  id: text("id").primaryKey(),
  runId: text("run_id")
    .notNull()
    .references(() => pipelineRuns.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  status: text("status").notNull().default("pending"), // 'pending' | 'running' | 'complete' | 'error'
  retryCount: integer("retry_count").default(0),
  errorMessage: text("error_message"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

// ── Chat ───────────────────────────────────────────────────────────────────────

export const chatSessions = sqliteTable("chat_sessions", {
  id: text("id").primaryKey(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  lastMessageAt: integer("last_message_at", { mode: "timestamp" }),
});

export const chatMessages = sqliteTable("chat_messages", {
  id: text("id").primaryKey(),
  sessionId: text("session_id")
    .notNull()
    .references(() => chatSessions.id, { onDelete: "cascade" }),
  role: text("role").notNull(), // 'user' | 'assistant'
  content: text("content").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

// ── Configuration ──────────────────────────────────────────────────────────────

export const sectors = sqliteTable("sectors", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  keywords: text("keywords"), // JSON array of search terms
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const fiscalCalendars = sqliteTable("fiscal_calendars", {
  id: text("id").primaryKey(),
  entityName: text("entity_name").notNull().unique(), // e.g. 'Maybank'
  yearStartMonth: integer("year_start_month").notNull().default(1), // 1=Jan
  quarterStartMonths: text("quarter_start_months").notNull().default("[1,4,7,10]"), // JSON array
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const extractionItems = sqliteTable("extraction_items", {
  id: text("id").primaryKey(),
  label: text("label").notNull().unique(), // e.g. 'Capital Stress'
  category: text("category"), // e.g. 'Basel Pillar 1'
  prompt: text("prompt").notNull(), // Template injected into Gemini extraction prompt
  outputSchema: text("output_schema"), // JSON Schema for structured output
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const eventExtractionItems = sqliteTable("event_extraction_items", {
  id: text("id").primaryKey(),
  eventId: text("event_id")
    .notNull()
    .references(() => events.id, { onDelete: "cascade" }),
  extractionItemId: text("extraction_item_id")
    .notNull()
    .references(() => extractionItems.id),
  valueJson: text("value_json"), // JSON result from Gemini
});
