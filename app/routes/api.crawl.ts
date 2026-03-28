import type { ActionFunctionArgs } from "@react-router/node";
import { nanoid } from "nanoid";
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
  };

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

  const runId = await runPipeline({
    query: body.query,
    sessionId,
    maxResults: body.maxResults,
    dayRange: body.dayRange,
  });

  return Response.json({ runId, sessionId });
}
