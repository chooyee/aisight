import type { ActionFunctionArgs } from "react-router";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import { getDb } from "~/lib/db/client";
import { chatSessions, chatMessages } from "~/lib/db/schema";
import { runPipeline } from "~/lib/pipeline/orchestrator";

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const body = await request.json() as {
    query: string;
    sessionId?: string;
    maxResults?: number;
    dayRange?: number;
    sourceDomain?: string;
    researchMode?: boolean;
    supervisorMode?: boolean;
    researchGoal?: string;
    minConfidence?: number;
  };

  const researchMode = body.researchMode ?? body.supervisorMode ?? false;

  if (!body.query?.trim()) {
    return Response.json({ error: "query is required" }, { status: 400 });
  }

  const db = getDb();

  // Create or reuse chat session
  let sessionId = body.sessionId;
  if (!sessionId) {
    sessionId = nanoid();
    await db.insert(chatSessions).values({
      id: sessionId,
      createdAt: new Date(),
      lastMessageAt: new Date(),
    });
  }

  // Log user message
  await db.insert(chatMessages).values({
    id: nanoid(),
    sessionId,
    role: "user",
    content: body.query,
    createdAt: new Date(),
  });

  await db
    .update(chatSessions)
    .set({ lastMessageAt: new Date() })
    .where(eq(chatSessions.id, sessionId));

  const runId = await runPipeline({
    query: body.query,
    sessionId,
    maxResults: body.maxResults,
    dayRange: body.dayRange,
    sourceDomain: body.sourceDomain,
    supervisorMode: researchMode,
    researchGoal: body.researchGoal,
    minConfidence: body.minConfidence,
  });

  return Response.json({
    runId,
    sessionId,
    mode: researchMode ? "research" : "standard",
  });
}
