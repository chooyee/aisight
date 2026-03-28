import {
  GoogleGenerativeAI,
  HarmBlockThreshold,
  HarmCategory,
} from "@google/generative-ai";
import { logger } from "../logger.js";
import { getDb } from "../db/client.js";
import { extractionItems } from "../db/schema.js";
import { eq } from "drizzle-orm";

export interface ExtractedEntity {
  name: string;
  type: "company" | "regulator" | "person" | "instrument";
  role: string;
  jurisdiction?: string;
}

export interface ExtractedRelationship {
  source: string;
  target: string;
  type: string;
}

export interface ExtractedRiskSignal {
  riskType: string;
  category: string;
  severity: "low" | "medium" | "high";
  direction: "positive" | "negative" | "neutral";
  rationale: string;
}

export interface ExtractionResult {
  eventDate?: string;
  entities: ExtractedEntity[];
  relationships: ExtractedRelationship[];
  summary: string;
  riskSignals: ExtractedRiskSignal[];
  extractionItems: Record<string, { detected: boolean; evidence: string }>;
}

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

/** Tier 1: Gemini Flash — entity/event/risk extraction from article text */
export async function extractFromArticle(
  articleText: string,
  articleUrl: string
): Promise<ExtractionResult | null> {
  try {
    const db = getDb();

    // Load active configurable extraction items from DB
    const activeItems = await db
      .select()
      .from(extractionItems)
      .where(eq(extractionItems.active, true));

    const itemsSection =
      activeItems.length > 0
        ? `\n\nFor each of the following regulatory items, determine if evidence exists in the article:\n${activeItems
            .map((it) => `- "${it.label}" (${it.category ?? "General"}): ${it.prompt}`)
            .join("\n")}`
        : "";

    const prompt = `You are a financial intelligence analyst for a Central Bank supervisor.
Analyse the following news article and extract structured information.

Article URL: ${articleUrl}
Article Text:
---
${articleText.slice(0, 8000)}
---

Return ONLY valid JSON with this exact structure:
{
  "eventDate": "YYYY-MM-DD or null",
  "entities": [
    { "name": "string", "type": "company|regulator|person|instrument", "role": "string", "jurisdiction": "2-letter country code or null" }
  ],
  "relationships": [
    { "source": "entity name", "target": "entity name", "type": "regulated_by|acquired|competes_with|investigated_by|partnered_with|mentions" }
  ],
  "summary": "2-3 sentence factual summary of what happened",
  "riskSignals": [
    { "riskType": "string", "category": "Basel Pillar 1|Basel Pillar 2|Basel Pillar 3|Supervisory|Corporate|Market", "severity": "low|medium|high", "direction": "positive|negative|neutral", "rationale": "string" }
  ],
  "extractionItems": {
    "item label": { "detected": true|false, "evidence": "direct quote or null" }
  }
}
${itemsSection}

Rules:
- eventDate must be the actual event date, not the publication date if different
- Only include entities explicitly mentioned in the article
- riskSignals only if the article contains clear evidence
- extractionItems keys must exactly match the provided labels`;

    const model = getAI().getGenerativeModel({
      model: "gemini-1.5-flash",
      safetySettings: SAFETY_SETTINGS,
      generationConfig: { responseMimeType: "application/json" },
    });

    const result = await model.generateContent(prompt);
    const text = result.response.text();

    const parsed = JSON.parse(text) as ExtractionResult;
    return parsed;
  } catch (err) {
    logger.error({ err, url: articleUrl }, "Gemini extraction failed");
    return null;
  }
}

/** Tier 2: Gemini Pro — complex reasoning, cross-article synthesis */
export async function reasonAcrossArticles(
  prompt: string
): Promise<string | null> {
  try {
    const model = getAI().getGenerativeModel({
      model: "gemini-1.5-pro",
      safetySettings: SAFETY_SETTINGS,
    });

    const result = await model.generateContent(prompt);
    return result.response.text();
  } catch (err) {
    logger.error({ err }, "Gemini Pro reasoning failed");
    return null;
  }
}
