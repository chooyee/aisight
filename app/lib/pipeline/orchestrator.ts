import { nanoid } from "nanoid";
import { eq, and, isNull } from "drizzle-orm";
import { getDb } from "../db/client.js";
import {
  articles,
  articleEntities,
  chatMessages,
  chatSessions,
  entities,
  relationships,
  events,
  riskSignals,
  eventExtractionItems,
  extractionItems,
  entityAffiliations,
  pipelineRuns,
  pipelineItems,
  supervisorBriefs,
  supervisorFindings,
} from "../db/schema.js";
import { pipelineEmitter } from "../sse/emitter.js";
import { searchNews, crawlDomain } from "./tavilySearch.js";
import { fetchWithReadability } from "./readabilityFetch.js";
import { fetchWithPlaywright } from "./playwrightFetch.js";
import { extractFromArticle, reasonAcrossArticles } from "./geminiExtract.js";
import { hashUrl } from "./dedup.js";
import { logger } from "../logger.js";

export interface PipelineConfig {
  query: string;
  sessionId: string;
  maxResults?: number;
  dayRange?: number;
  /** Restrict search to a specific domain, e.g. "thestar.com.my" */
  sourceDomain?: string;
  supervisorMode?: boolean;
  researchGoal?: string;
  minConfidence?: number;
}

type AssistantResultPayload = {
  kind: "assistant_result_v1";
  summary: string;
  confidence?: number;
  keyFindings?: string[];
  recommendations?: string[];
  sources?: string[];
  articleTitles?: string[];
  articleIds?: string[];
  status?: "complete" | "error";
  itemsTotal?: number;
  itemsCompleted?: number;
};

function emit(sessionId: string, type: string, payload: Record<string, unknown>) {
  pipelineEmitter.emit(sessionId, { type, ...payload } as never);
}

async function persistAssistantMessage(
  sessionId: string,
  payload: AssistantResultPayload
) {
  const db = getDb();
  const now = new Date();

  await db.insert(chatMessages).values({
    id: nanoid(),
    sessionId,
    role: "assistant",
    content: JSON.stringify(payload),
    createdAt: now,
  });

  await db
    .update(chatSessions)
    .set({ lastMessageAt: now })
    .where(eq(chatSessions.id, sessionId));
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
    supervisorMode: config.supervisorMode === true,
    sourceDomain: config.sourceDomain ?? null,
    researchGoal: config.researchGoal ?? null,
    startedAt: new Date(),
  });

  // Run in background — don't await
  void executePipeline(runId, config).catch((err) => {
    logger.error({ err, runId }, "Pipeline crashed");
    db.update(pipelineRuns)
      .set({ status: "error", errorMessage: String(err), completedAt: new Date() })
      .where(eq(pipelineRuns.id, runId))
      .run();
    void persistAssistantMessage(config.sessionId, {
      kind: "assistant_result_v1",
      summary: String(err),
      status: "error",
    }).catch((persistErr) => {
      logger.error({ err: persistErr, runId }, "Failed to persist pipeline crash message");
    });
    emit(config.sessionId, "error", { message: String(err) });
  });

  return runId;
}

async function executePipeline(runId: string, config: PipelineConfig) {
  const db = getDb();
  const { sessionId, query } = config;
  const supervisorMode = config.supervisorMode === true;
  const minConfidence = config.minConfidence ?? 0;
  const bufferedFindings: Array<{
    articleId: string;
    entityId: string | null;
    eventId: string | null;
    findingType: string;
    claim: string;
    evidenceQuote: string | null;
    sourceUrl: string;
    confidence: number;
    severity: string | null;
  }> = [];
  const processedArticles: Array<{ title: string; url: string; articleId: string }> = [];

  // ── Phase 1: Search ───────────────────────────────────────────────────────
  emit(sessionId, "progress", { stage: "search", message: `Searching: "${query}"`, percent: 5 });

  const searchResults = config.sourceDomain
    ? await crawlDomain(config.sourceDomain, query, {
        maxResults: config.maxResults ?? 15,
        days: config.dayRange ?? 30,
      })
    : await searchNews(query, {
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

      emit(sessionId, "article", { url: result.url, title: result.title ?? result.url, articleId });
      processedArticles.push({ title: result.title ?? result.url, url: result.url, articleId });

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

        // Insert affiliations (person↔company roles extracted from article)
        for (const aff of extraction.affiliations ?? []) {
          const personId = entityIdMap.get(aff.personName);
          const companyId = entityIdMap.get(aff.companyName);

          if (!personId || !companyId) continue;

          const [dup] = await db
            .select({ id: entityAffiliations.id })
            .from(entityAffiliations)
            .where(
              and(
                eq(entityAffiliations.entityId, personId),
                eq(entityAffiliations.relatedEntityId, companyId),
                eq(entityAffiliations.affiliationType, aff.affiliationType),
                aff.role ? eq(entityAffiliations.role, aff.role) : isNull(entityAffiliations.role)
              )
            )
            .limit(1);

          if (dup) continue;

          const isCurrent = aff.isCurrent ?? (aff.endDate == null);
          await db.insert(entityAffiliations).values({
            id: nanoid(),
            entityId: personId,
            relatedEntityId: companyId,
            affiliationType: aff.affiliationType,
            role: aff.role,
            startDate: aff.startDate ?? null,
            endDate: isCurrent ? null : (aff.endDate ?? null),
            isCurrent,
            source: "llm_research",
            confidence: 0.75,
          });
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

          if (supervisorMode) {
            const confidence = signal.severity === "high" ? 0.9 : signal.severity === "medium" ? 0.75 : 0.65;
            if (confidence >= minConfidence) {
              bufferedFindings.push({
                articleId,
                entityId: signalEntityId ?? null,
                eventId,
                findingType: extraction.eventType ?? "risk_event",
                claim: signal.riskType,
                evidenceQuote: signal.rationale ?? null,
                sourceUrl: result.url,
                confidence,
                severity: signal.severity ?? null,
              });

              emit(sessionId, "finding", {
                claim: signal.riskType,
                severity: signal.severity ?? "unknown",
                sourceUrl: result.url,
                confidence,
              });
            }
          }
        }

        if (supervisorMode && extraction.summary) {
          const confidence = 0.7;
          if (confidence >= minConfidence) {
            bufferedFindings.push({
              articleId,
              entityId: extraction.entities[0]?.name ? (entityIdMap.get(extraction.entities[0].name) ?? null) : null,
              eventId,
              findingType: extraction.eventType ?? "event",
              claim: extraction.summary,
              evidenceQuote: result.content.slice(0, 280) || null,
              sourceUrl: result.url,
              confidence,
              severity: null,
            });
          }
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

  if (supervisorMode) {
    for (const finding of bufferedFindings) {
      await db.insert(supervisorFindings).values({
        id: nanoid(),
        runId,
        articleId: finding.articleId,
        entityId: finding.entityId,
        eventId: finding.eventId,
        findingType: finding.findingType,
        claim: finding.claim,
        evidenceQuote: finding.evidenceQuote,
        sourceUrl: finding.sourceUrl,
        confidence: finding.confidence,
        severity: finding.severity,
      });
    }

    const topFindings = bufferedFindings
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 8)
      .map((f, i) => `${i + 1}. [${f.findingType}] ${f.claim} (severity: ${f.severity ?? "n/a"}, confidence: ${f.confidence.toFixed(2)}, source: ${f.sourceUrl})`)
      .join("\n");

    const briefingPrompt = `You are a supervisor research assistant. Summarise the run as strict JSON only.\n\nQuery: ${query}\nResearch Goal: ${config.researchGoal ?? "General supervisor research"}\nFindings:\n${topFindings || "No findings."}\n\nReturn ONLY JSON:\n{\n  "summary": "string",\n  "keyFindings": ["string"],\n  "recommendations": ["string"],\n  "confidence": 0.0\n}`;

    const synthesis = await reasonAcrossArticles(briefingPrompt);
    let summary = "No supervisor summary generated.";
    let keyFindings: string[] = topFindings ? topFindings.split("\n") : [];
    let recommendations: string[] = [];
    let confidence = bufferedFindings.length > 0 ? 0.7 : 0.4;

    if (synthesis) {
      try {
        const cleaned = synthesis.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
        const parsed = JSON.parse(cleaned) as {
          summary?: string;
          keyFindings?: string[];
          recommendations?: string[];
          confidence?: number;
        };
        summary = parsed.summary ?? summary;
        keyFindings = parsed.keyFindings ?? keyFindings;
        recommendations = parsed.recommendations ?? recommendations;
        confidence = typeof parsed.confidence === "number" ? parsed.confidence : confidence;
      } catch (err) {
        logger.warn({ err, runId }, "Failed to parse supervisor synthesis JSON");
      }
    }

    await db.insert(supervisorBriefs).values({
      id: nanoid(),
      runId,
      summary,
      keyFindingsJson: JSON.stringify(keyFindings),
      recommendationsJson: JSON.stringify(recommendations),
      confidence,
      updatedAt: new Date(),
    });

    emit(sessionId, "brief_ready", {
      runId,
      summary,
      confidence,
      keyFindingsCount: keyFindings.length,
    });

    const sources = Array.from(
      new Set(
        bufferedFindings
          .map((finding) => finding.sourceUrl)
          .filter((url): url is string => Boolean(url))
      )
    ).slice(0, 5);

    emit(sessionId, "research_result", {
      runId,
      summary,
      confidence,
      keyFindings,
      recommendations,
      sources,
    });

    await persistAssistantMessage(sessionId, {
      kind: "assistant_result_v1",
      summary,
      confidence,
      keyFindings,
      recommendations,
      sources,
      status: "complete",
      itemsTotal: newResults.length,
      itemsCompleted: completed,
    });
  } else {
    const summary = `Research completed. Processed ${completed}/${newResults.length} articles.`;
    const sources = newResults.slice(0, 5).map((result) => result.url);

    await persistAssistantMessage(sessionId, {
      kind: "assistant_result_v1",
      summary,
      confidence: completed > 0 ? 0.5 : 0,
      keyFindings: [],
      recommendations: [],
      sources,
      articleTitles: processedArticles.map((a) => a.title),
      articleIds: processedArticles.map((a) => a.articleId),
      status: "complete",
      itemsTotal: newResults.length,
      itemsCompleted: completed,
    });
  }

  emit(sessionId, "complete", {
    runId,
    itemsTotal: newResults.length,
    itemsCompleted: completed,
  });

  logger.info({ runId, completed, total: newResults.length }, "Pipeline complete");
}
