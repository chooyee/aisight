import type { LoaderFunctionArgs } from "react-router";
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "~/lib/db/client";
import { pipelineRuns, supervisorBriefs, supervisorReviews } from "~/lib/db/schema";

// GET /api/research/runs
export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1"));
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") ?? "20")));
  const offset = (page - 1) * limit;
  const status = url.searchParams.get("status");
  const mode = url.searchParams.get("mode") ?? "research";

  const db = getDb();
  const filters = [];

  if (mode === "research" || mode === "supervisor") {
    filters.push(eq(pipelineRuns.supervisorMode, true));
  }

  if (status === "reviewed") {
    filters.push(sql`${supervisorReviews.id} is not null`);
  } else if (status && status !== "all") {
    filters.push(eq(pipelineRuns.status, status));
  }

  const where = filters.length > 0 ? and(...filters) : undefined;

  const rows = await db
    .select({
      id: pipelineRuns.id,
      sessionId: pipelineRuns.sessionId,
      status: pipelineRuns.status,
      query: pipelineRuns.query,
      supervisorMode: pipelineRuns.supervisorMode,
      sourceDomain: pipelineRuns.sourceDomain,
      researchGoal: pipelineRuns.researchGoal,
      itemsTotal: pipelineRuns.itemsTotal,
      itemsCompleted: pipelineRuns.itemsCompleted,
      startedAt: pipelineRuns.startedAt,
      completedAt: pipelineRuns.completedAt,
      briefSummary: supervisorBriefs.summary,
      briefConfidence: supervisorBriefs.confidence,
      reviewDecision: supervisorReviews.decision,
      reviewedAt: supervisorReviews.reviewedAt,
    })
    .from(pipelineRuns)
    .leftJoin(supervisorBriefs, eq(supervisorBriefs.runId, pipelineRuns.id))
    .leftJoin(supervisorReviews, eq(supervisorReviews.runId, pipelineRuns.id))
    .where(where)
    .orderBy(desc(pipelineRuns.startedAt))
    .limit(limit)
    .offset(offset);

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(pipelineRuns)
    .leftJoin(supervisorReviews, eq(supervisorReviews.runId, pipelineRuns.id))
    .where(where);

  return Response.json({
    runs: rows,
    page,
    limit,
    total: count,
  });
}
