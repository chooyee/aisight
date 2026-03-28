import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import {
  articles,
  articleEntities,
  entities,
  relationships,
  events,
  riskSignals,
  eventExtractionItems,
  extractionItems,
  pipelineRuns,
  pipelineItems,
} from "../db/schema.js";
import { pipelineEmitter } from "../sse/emitter.js";
import { searchNews } from "./tavilySearch.js";
import { fetchWithReadability } from "./readabilityFetch.js";
import { fetchWithPlaywright } from "./playwrightFetch.js";
import { extractFromArticle } from "./geminiExtract.js";
import { hashUrl } from "./dedup.js";
import { logger } from "../logger.js";

export interface PipelineConfig {
  query: string;
  sessionId: string;
  maxResults?: number;
  dayRange?: number;
}

function emit(sessionId: string, type: string, payload: Record<string, unknown>) {
  pipelineEmitter.emit(sessionId, { type, ...payload } as never);
}

export async function runPipeline(config: PipelineConfig): Promise<string> {
  const db = getDb();
  const runId = nanoid();

  // Create run record
  await db.insert(pipelineRuns).values({
    id: runId,
    sessionId: config.sessionId,
    status: "running",
    query: config.query,
    startedAt: new Date(),
  });

  // Run in background — don't await
  void executePipeline(runId, config).catch((err) => {
    logger.error({ err, runId }, "Pipeline crashed");
    db.update(pipelineRuns)
      .set({ status: "error", errorMessage: String(err), completedAt: new Date() })
      .where(eq(pipelineRuns.id, runId))
      .run();
    emit(config.sessionId, "error", { message: String(err) });
  });

  return runId;
}

async function executePipeline(runId: string, config: PipelineConfig) {
  const db = getDb();
  const { sessionId, query } = config;

  // ── Phase 1: Search ───────────────────────────────────────────────────────
  emit(sessionId, "progress", { stage: "search", message: `Searching: "${query}"`, percent: 5 });

  const searchResults = await searchNews(query, {
    maxResults: config.maxResults ?? 10,
    days: config.dayRange ?? 7,
  });

  emit(sessionId, "progress", {
    stage: "search",
    message: `Found ${searchResults.length} results`,
    percent: 15,
  });

  // ── Phase 2: Deduplicate ──────────────────────────────────────────────────
  const existingHashes = new Set(
    (await db.select({ urlHash: articles.urlHash }).from(articles)).map((r) => r.urlHash)
  );

  const newResults = searchResults.filter(
    (r) => !existingHashes.has(hashUrl(r.url))
  );

  await db
    .update(pipelineRuns)
    .set({ itemsTotal: newResults.length })
    .where(eq(pipelineRuns.id, runId));

  emit(sessionId, "progress", {
    stage: "dedup",
    message: `${newResults.length} new articles after deduplication`,
    percent: 20,
  });

  if (newResults.length === 0) {
    await db
      .update(pipelineRuns)
      .set({ status: "complete", completedAt: new Date(), itemsCompleted: 0 })
      .where(eq(pipelineRuns.id, runId));
    emit(sessionId, "complete", { runId, itemsTotal: 0, itemsCompleted: 0 });
    return;
  }

  // ── Phase 3: Scrape + Extract ─────────────────────────────────────────────
  let completed = 0;

  for (const result of newResults) {
    const itemId = nanoid();
    await db.insert(pipelineItems).values({
      id: itemId,
      runId,
      url: result.url,
      status: "running",
    });

    try {
      emit(sessionId, "progress", {
        stage: "scrape",
        message: `Scraping: ${result.url}`,
        percent: 20 + Math.round((completed / newResults.length) * 60),
      });

      // Tier 1: use Tavily raw_content if sufficient
      let content = result.content;
      let publishedAt: Date | undefined;
      let scrapeMethod = "tavily";

      if (!content || content.length < 200) {
        // Tier 2: HTTP + Readability
        const fetched = await fetchWithReadability(result.url);
        if (fetched) {
          content = fetched.content;
          publishedAt = fetched.publishedAt;
          scrapeMethod = "readability";
        } else {
          // Tier 3: Playwright CDP
          const pwFetched = await fetchWithPlaywright(result.url);
          if (pwFetched) {
            content = pwFetched.content;
            publishedAt = pwFetched.publishedAt;
            scrapeMethod = "playwright";
          }
        }
      }

      if (!content || content.length < 50) {
        throw new Error("Insufficient content after all scraping tiers");
      }

      emit(sessionId, "article", { url: result.url, title: result.title });

      // ── Phase 4: Extract ────────────────────────────────────────────────
      emit(sessionId, "progress", {
        stage: "extract",
        message: `Extracting entities from: ${result.title}`,
        percent: 20 + Math.round((completed / newResults.length) * 60) + 5,
      });

      const articleId = nanoid();
      await db.insert(articles).values({
        id: articleId,
        url: result.url,
        urlHash: hashUrl(result.url),
        title: result.title,
        content,
        publishedAt: publishedAt ?? (result.publishedDate ? new Date(result.publishedDate) : null),
        scrapedAt: new Date(),
        source: scrapeMethod as "tavily" | "readability" | "playwright",
      });

      const extraction = await extractFromArticle(content, result.url);

      if (extraction) {
        // Upsert entities — collect IDs for linking risk signals
        const entityIdMap = new Map<string, string>();
        for (const ent of extraction.entities) {
          const existing = await db
            .select()
            .from(entities)
            .where(eq(entities.name, ent.name))
            .limit(1);

          let entityId: string;
          if (existing.length > 0) {
            entityId = existing[0].id;
          } else {
            entityId = nanoid();
            await db.insert(entities).values({
              id: entityId,
              name: ent.name,
              type: ent.type,
              country: ent.jurisdiction,
              firstSeenAt: new Date(),
            });
            emit(sessionId, "entity", { name: ent.name, entityType: ent.type });
          }

          entityIdMap.set(ent.name, entityId);

          await db.insert(articleEntities).values({
            id: nanoid(),
            articleId,
            entityId,
            confidence: 0.9,
            context: ent.role,
          });
        }

        // Insert relationships
        for (const rel of extraction.relationships) {
          const fromEnt = await db
            .select()
            .from(entities)
            .where(eq(entities.name, rel.source))
            .limit(1);
          const toEnt = await db
            .select()
            .from(entities)
            .where(eq(entities.name, rel.target))
            .limit(1);

          if (fromEnt.length > 0 && toEnt.length > 0) {
            await db.insert(relationships).values({
              id: nanoid(),
              fromEntityId: fromEnt[0].id,
              toEntityId: toEnt[0].id,
              relationshipType: rel.type,
              articleId,
            });
          }
        }

        // Insert event + risk signals
        const eventId = nanoid();
        await db.insert(events).values({
          id: eventId,
          articleId,
          description: extraction.summary,
          eventType: extraction.eventType ?? null,
          occurredAt: extraction.eventDate ? new Date(extraction.eventDate) : null,
        });

        for (const signal of extraction.riskSignals) {
          // Try to find a matching entity for this risk signal
          const firstEntityName = extraction.entities[0]?.name;
          const signalEntityId = firstEntityName ? entityIdMap.get(firstEntityName) : undefined;

          await db.insert(riskSignals).values({
            id: nanoid(),
            eventId,
            entityId: signalEntityId ?? null,
            riskType: signal.riskType,
            category: signal.category,
            severity: signal.severity,
            direction: signal.direction,
            rationale: signal.rationale,
          });
        }

        // Store configurable extraction item results
        const activeItems = await db
          .select()
          .from(extractionItems)
          .where(eq(extractionItems.active, true));

        for (const item of activeItems) {
          const val = extraction.extractionItems?.[item.label];
          if (val) {
            await db.insert(eventExtractionItems).values({
              id: nanoid(),
              eventId,
              extractionItemId: item.id,
              valueJson: JSON.stringify(val),
            });
          }
        }
      }

      await db
        .update(pipelineItems)
        .set({ status: "complete", updatedAt: new Date() })
        .where(eq(pipelineItems.id, itemId));

      completed++;
      await db
        .update(pipelineRuns)
        .set({ itemsCompleted: completed })
        .where(eq(pipelineRuns.id, runId));
    } catch (err) {
      logger.error({ err, url: result.url }, "Pipeline item failed");
      await db
        .update(pipelineItems)
        .set({ status: "error", errorMessage: String(err), updatedAt: new Date() })
        .where(eq(pipelineItems.id, itemId));
    }
  }

  // ── Done ──────────────────────────────────────────────────────────────────
  await db
    .update(pipelineRuns)
    .set({ status: "complete", completedAt: new Date(), itemsCompleted: completed })
    .where(eq(pipelineRuns.id, runId));

  emit(sessionId, "complete", {
    runId,
    itemsTotal: newResults.length,
    itemsCompleted: completed,
  });

  logger.info({ runId, completed, total: newResults.length }, "Pipeline complete");
}
