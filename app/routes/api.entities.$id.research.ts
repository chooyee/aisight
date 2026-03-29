import type { ActionFunctionArgs } from "@react-router/node";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getDb } from "~/lib/db/client";
import { entities, entityProfiles, entityAffiliations } from "~/lib/db/schema";
import { logger } from "~/lib/logger";
import { GoogleGenerativeAI, HarmBlockThreshold, HarmCategory } from "@google/generative-ai";

const SAFETY_SETTINGS = [
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

let _ai: GoogleGenerativeAI | undefined;
function getAI() {
  if (!_ai) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
    _ai = new GoogleGenerativeAI(apiKey);
  }
  return _ai;
}

// Optional Tavily
let tavilySearch: ((query: string) => Promise<{ title: string; url: string; content: string }[]>) | null = null;
try {
  const { tavily } = await import("@tavily/core");
  const apiKey = process.env.TAVILY_API_KEY;
  if (apiKey) {
    const client = tavily({ apiKey });
    tavilySearch = async (query: string) => {
      const resp = await client.search(query, { maxResults: 5, topic: "general" as const });
      return resp.results.map((r: { title?: string; url?: string; content?: string }) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        content: r.content ?? "",
      }));
    };
  }
} catch { /* Tavily unavailable */ }

// POST /api/entities/:id/research  — deep-research affiliations via Tavily + Gemini
export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const { id } = params;
  if (!id) return Response.json({ error: "Missing id" }, { status: 400 });

  const db = getDb();
  const [entity] = await db.select().from(entities).where(eq(entities.id, id));
  if (!entity) return Response.json({ error: "Entity not found" }, { status: 404 });

  const [profile] = await db.select().from(entityProfiles).where(eq(entityProfiles.entityId, id));

  try {
    // ── Step 1: Web search ──────────────────────────────────────────────────

    let searchContext = "";
    let searchSummary = "";

    if (tavilySearch) {
      const queries =
        entity.type === "person"
          ? [
              `${entity.name} career history positions held`,
              `${entity.name} board director appointments`,
            ]
          : [
              `${entity.name} subsidiaries shareholders ownership structure`,
              `${entity.name} parent company ownership`,
            ];

      const results: { title: string; url: string; content: string }[] = [];
      for (const q of queries) {
        try {
          const r = await tavilySearch(q);
          results.push(...r);
        } catch { /* ignore individual query failures */ }
      }

      searchContext = results
        .slice(0, 8)
        .map((r) => `### ${r.title}\nURL: ${r.url}\n${r.content.slice(0, 500)}`)
        .join("\n\n");
      searchSummary = `Web search: ${results.length} result(s) found`;
    } else {
      searchSummary = "No web search (TAVILY_API_KEY not set) — Gemini will use general knowledge";
    }

    // ── Step 2: Gemini extraction ───────────────────────────────────────────

    const entityDesc = [
      `Name: ${entity.name}`,
      `Type: ${entity.type}`,
      entity.sector ? `Sector: ${entity.sector}` : null,
      entity.country ? `Country: ${entity.country}` : null,
      profile?.description ? `Description: ${profile.description}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    const affiliationTypeGuide =
      entity.type === "person"
        ? "Focus on: employment (jobs/CEO/MD/Director roles), board (non-exec board seats), advisory (advisory board)."
        : "Focus on: ownership (subsidiary/parent relationships, percentage stakes), board (board members appointed by this company).";

    const prompt = `You are a financial intelligence analyst. Extract all known affiliations for the following entity.

## Entity
${entityDesc}

## Web Search Results
${searchContext || "No web search results available. Use general knowledge."}

## Task
${affiliationTypeGuide}

Return ONLY a valid JSON object (no markdown, no explanation) matching this exact schema:
{
  "affiliations": [
    {
      "relatedEntityName": "exact name of the related company/organisation/person",
      "relatedEntityType": "company" | "regulator" | "person" | "instrument",
      "affiliationType": "employment" | "board" | "ownership" | "advisory" | "regulatory",
      "role": "job title or stake description, e.g. CEO or 70% shareholder, or null",
      "ownershipPct": null or number 0-100,
      "startDate": "YYYY or YYYY-MM or YYYY-MM-DD or null",
      "endDate": "YYYY or YYYY-MM or YYYY-MM-DD or null (null if still current)",
      "isCurrent": true or false,
      "notes": "brief provenance note, e.g. source URL or 'general knowledge'"
    }
  ]
}

Rules:
- Include BOTH current and historical affiliations.
- Use null for unknown dates — do not guess.
- ownershipPct should only be set for "ownership" affiliationType.
- Maximum 20 affiliations. Prioritise the most significant ones.`;

    const model = getAI().getGenerativeModel({
      model: "gemini-2.5-flash-lite",
      safetySettings: SAFETY_SETTINGS,
    });

    const result = await model.generateContent(prompt);
    const raw = result.response.text().trim();

    // Strip markdown fences if present
    const jsonStr = raw.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
    const parsed = JSON.parse(jsonStr) as { affiliations: unknown[] };

    // Update researchedAt on the profile
    if (profile) {
      await db
        .update(entityProfiles)
        .set({ researchedAt: new Date(), updatedAt: new Date() })
        .where(eq(entityProfiles.entityId, id));
    }

    // ── Auto-save extracted affiliations to DB ─────────────────────────────
    type RawAffiliation = {
      relatedEntityName: string;
      relatedEntityType: string;
      affiliationType: string;
      role?: string | null;
      ownershipPct?: number | null;
      startDate?: string | null;
      endDate?: string | null;
      isCurrent?: boolean;
      notes?: string | null;
    };

    const rawList = (parsed.affiliations ?? []) as RawAffiliation[];
    const savedAffiliations: unknown[] = [];

    for (const item of rawList) {
      if (!item.relatedEntityName || !item.affiliationType) continue;

      // Find or create the related entity
      let [relatedEntity] = await db
        .select()
        .from(entities)
        .where(eq(entities.name, item.relatedEntityName))
        .limit(1);

      if (!relatedEntity) {
        const newId = nanoid();
        [relatedEntity] = await db
          .insert(entities)
          .values({
            id: newId,
            name: item.relatedEntityName,
            type: (item.relatedEntityType ?? "company") as "company" | "regulator" | "person" | "instrument",
            firstSeenAt: new Date(),
          })
          .returning();
      }

      // Skip if this exact affiliation already exists
      const [existing] = await db
        .select({ id: entityAffiliations.id })
        .from(entityAffiliations)
        .where(
          and(
            eq(entityAffiliations.entityId, id),
            eq(entityAffiliations.relatedEntityId, relatedEntity.id),
            eq(entityAffiliations.affiliationType, item.affiliationType),
            eq(entityAffiliations.role, item.role ?? "")
          )
        )
        .limit(1);

      if (existing) {
        savedAffiliations.push({ ...item, id: existing.id, relatedEntityId: relatedEntity.id, skipped: true });
        continue;
      }

      const isCurrent = item.isCurrent ?? (item.endDate == null);
      const [inserted] = await db
        .insert(entityAffiliations)
        .values({
          id: nanoid(),
          entityId: id,
          relatedEntityId: relatedEntity.id,
          affiliationType: item.affiliationType as "employment" | "board" | "ownership" | "advisory" | "regulatory",
          role: item.role ?? null,
          ownershipPct: item.ownershipPct ?? null,
          startDate: item.startDate ?? null,
          endDate: isCurrent ? null : (item.endDate ?? null),
          isCurrent,
          source: "llm_research",
          confidence: 0.8,
          notes: item.notes ?? null,
        })
        .returning();

      savedAffiliations.push({
        ...inserted,
        relatedName: relatedEntity.name,
        relatedType: relatedEntity.type,
      });
    }

    return Response.json({
      affiliations: savedAffiliations,
      searchSummary,
    });
  } catch (err) {
    logger.error({ err }, "Entity research failed");
    return Response.json({ error: "Research failed", detail: String(err) }, { status: 500 });
  }
}
