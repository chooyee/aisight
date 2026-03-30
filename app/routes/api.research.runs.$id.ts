import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getDb } from "~/lib/db/client";
import {
  entities,
  pipelineRuns,
  supervisorBriefs,
  supervisorFindings,
  supervisorReviews,
} from "~/lib/db/schema";

// GET /api/research/runs/:id
export async function loader({ params }: LoaderFunctionArgs) {
  const id = params.id;
  if (!id) return Response.json({ error: "Missing id" }, { status: 400 });

  const db = getDb();

  const [run] = await db
    .select()
    .from(pipelineRuns)
    .where(and(eq(pipelineRuns.id, id), eq(pipelineRuns.supervisorMode, true)));

  if (!run) return Response.json({ error: "Run not found" }, { status: 404 });

  const [brief] = await db.select().from(supervisorBriefs).where(eq(supervisorBriefs.runId, id));
  const [review] = await db.select().from(supervisorReviews).where(eq(supervisorReviews.runId, id));

  const findings = await db
    .select({
      id: supervisorFindings.id,
      findingType: supervisorFindings.findingType,
      claim: supervisorFindings.claim,
      evidenceQuote: supervisorFindings.evidenceQuote,
      sourceUrl: supervisorFindings.sourceUrl,
      confidence: supervisorFindings.confidence,
      severity: supervisorFindings.severity,
      createdAt: supervisorFindings.createdAt,
      entityName: entities.name,
      entityType: entities.type,
    })
    .from(supervisorFindings)
    .leftJoin(entities, eq(supervisorFindings.entityId, entities.id))
    .where(eq(supervisorFindings.runId, id));

  return Response.json({
    run,
    brief: brief
      ? {
          ...brief,
          keyFindings: brief.keyFindingsJson ? JSON.parse(brief.keyFindingsJson) : [],
          recommendations: brief.recommendationsJson ? JSON.parse(brief.recommendationsJson) : [],
        }
      : null,
    findings,
    review: review ?? null,
  });
}

// POST /api/research/runs/:id
// Body: { decision: 'approve'|'reject'|'needs_followup', notes?: string, reviewer?: string }
export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const id = params.id;
  if (!id) return Response.json({ error: "Missing id" }, { status: 400 });

  const body = (await request.json()) as {
    decision?: "approve" | "reject" | "needs_followup";
    notes?: string;
    reviewer?: string;
  };

  if (!body.decision || !["approve", "reject", "needs_followup"].includes(body.decision)) {
    return Response.json({ error: "Invalid decision" }, { status: 400 });
  }

  const db = getDb();
  const [run] = await db
    .select({ id: pipelineRuns.id })
    .from(pipelineRuns)
    .where(and(eq(pipelineRuns.id, id), eq(pipelineRuns.supervisorMode, true)));

  if (!run) return Response.json({ error: "Run not found" }, { status: 404 });

  const now = new Date();

  const [existing] = await db
    .select({ id: supervisorReviews.id })
    .from(supervisorReviews)
    .where(eq(supervisorReviews.runId, id));

  if (existing) {
    await db
      .update(supervisorReviews)
      .set({
        decision: body.decision,
        notes: body.notes ?? null,
        reviewer: body.reviewer ?? null,
        reviewedAt: now,
      })
      .where(eq(supervisorReviews.id, existing.id));
  } else {
    await db.insert(supervisorReviews).values({
      id: nanoid(),
      runId: id,
      decision: body.decision,
      notes: body.notes ?? null,
      reviewer: body.reviewer ?? null,
      reviewedAt: now,
    });
  }

  return Response.json({ ok: true, runId: id, decision: body.decision, reviewedAt: now });
}
