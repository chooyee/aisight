import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, Link, useFetcher } from "react-router";
import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getDb } from "~/lib/db/client";
import {
  entities,
  pipelineRuns,
  supervisorBriefs,
  supervisorFindings,
  supervisorReviews,
} from "~/lib/db/schema";

function fmtDate(d: Date | null | undefined) {
  if (!d) return "-";
  return new Date(d).toLocaleString();
}

export async function loader({ request }: LoaderFunctionArgs) {
  const db = getDb();
  const url = new URL(request.url);
  const runId = url.searchParams.get("runId");

  const runs = await db
    .select({
      id: pipelineRuns.id,
      status: pipelineRuns.status,
      query: pipelineRuns.query,
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
    .where(eq(pipelineRuns.supervisorMode, true))
    .orderBy(desc(pipelineRuns.startedAt))
    .limit(60);

  let selected: {
    id: string;
    run: typeof runs[number];
    brief: null | {
      summary: string | null;
      keyFindings: string[];
      recommendations: string[];
      confidence: number | null;
    };
    findings: Array<{
      id: string;
      findingType: string;
      claim: string;
      evidenceQuote: string | null;
      sourceUrl: string | null;
      confidence: number | null;
      severity: string | null;
      createdAt: Date;
      entityName: string | null;
      entityType: string | null;
    }>;
    review: null | {
      decision: string;
      reviewer: string | null;
      notes: string | null;
      reviewedAt: Date;
    };
  } | null = null;

  const resolvedRunId = runId ?? runs[0]?.id ?? null;

  if (resolvedRunId) {
    const [run] = await db
      .select({
        id: pipelineRuns.id,
        status: pipelineRuns.status,
        query: pipelineRuns.query,
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
      .where(and(eq(pipelineRuns.id, resolvedRunId), eq(pipelineRuns.supervisorMode, true)));

    if (run) {
      const [brief] = await db
        .select()
        .from(supervisorBriefs)
        .where(eq(supervisorBriefs.runId, resolvedRunId));

      const [review] = await db
        .select()
        .from(supervisorReviews)
        .where(eq(supervisorReviews.runId, resolvedRunId));

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
        .where(eq(supervisorFindings.runId, resolvedRunId))
        .orderBy(desc(supervisorFindings.confidence), desc(supervisorFindings.createdAt));

      selected = {
        id: resolvedRunId,
        run,
        brief: brief
          ? {
              summary: brief.summary,
              keyFindings: brief.keyFindingsJson ? JSON.parse(brief.keyFindingsJson) : [],
              recommendations: brief.recommendationsJson ? JSON.parse(brief.recommendationsJson) : [],
              confidence: brief.confidence,
            }
          : null,
        findings,
        review: review
          ? {
              decision: review.decision,
              reviewer: review.reviewer,
              notes: review.notes,
              reviewedAt: review.reviewedAt,
            }
          : null,
      };
    }
  }

  return { runs, selected };
}

export async function action({ request }: ActionFunctionArgs) {
  const db = getDb();
  const form = await request.formData();
  const intent = form.get("intent") as string;

  if (intent !== "review") {
    return Response.json({ error: "Unknown intent" }, { status: 400 });
  }

  const runId = form.get("runId") as string;
  const decision = form.get("decision") as string;
  const notes = ((form.get("notes") as string) ?? "").trim();

  if (!runId || !["approve", "reject", "needs_followup"].includes(decision)) {
    return Response.json({ error: "Invalid payload" }, { status: 400 });
  }

  const [existing] = await db
    .select({ id: supervisorReviews.id })
    .from(supervisorReviews)
    .where(eq(supervisorReviews.runId, runId));

  const now = new Date();

  if (existing) {
    await db
      .update(supervisorReviews)
      .set({
        decision,
        notes: notes || null,
        reviewedAt: now,
      })
      .where(eq(supervisorReviews.id, existing.id));
  } else {
    await db.insert(supervisorReviews).values({
      id: nanoid(),
      runId,
      decision,
      notes: notes || null,
      reviewedAt: now,
    });
  }

  return Response.json({ ok: true });
}

export default function OpsResearch() {
  const { runs, selected } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)] gap-4">
      <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)] overflow-hidden">
        <div className="px-3 py-2 border-b border-[var(--color-border)] text-xs text-white/50">
          Research runs ({runs.length})
        </div>
        <div className="max-h-[70vh] overflow-y-auto">
          {runs.map((run) => {
            const active = selected?.id === run.id;
            return (
              <Link
                key={run.id}
                to={`?runId=${run.id}`}
                className={`block px-3 py-2 border-b border-[var(--color-border)] hover:bg-white/5 ${active ? "bg-[var(--color-accent)]/12" : ""}`}
              >
                <div className="text-sm font-medium text-white/90 truncate">{run.query ?? "Untitled run"}</div>
                <div className="mt-1 text-[11px] text-white/45 flex items-center gap-2">
                  <span className="uppercase">{run.status}</span>
                  {run.reviewDecision && <span>• {run.reviewDecision}</span>}
                </div>
                <div className="mt-0.5 text-[11px] text-white/35">{fmtDate(run.startedAt)}</div>
              </Link>
            );
          })}
          {runs.length === 0 && (
            <div className="px-3 py-4 text-sm text-white/40">No research runs yet.</div>
          )}
        </div>
      </section>

      <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)] p-4">
        {!selected && <div className="text-sm text-white/50">Select a run to inspect details.</div>}

        {selected && (
          <div className="space-y-4">
            <div>
              <h2 className="text-base font-semibold text-white/90">{selected.run.query}</h2>
              <div className="mt-1 text-xs text-white/45">
                Status: {selected.run.status} • {selected.run.itemsCompleted ?? 0}/{selected.run.itemsTotal ?? 0} processed
              </div>
              <div className="mt-1 text-xs text-white/45">
                Domain: {selected.run.sourceDomain ?? "(none)"} • Started: {fmtDate(selected.run.startedAt)}
              </div>
              {selected.run.researchGoal && (
                <div className="mt-1 text-xs text-white/45">Goal: {selected.run.researchGoal}</div>
              )}
            </div>

            <div className="rounded-lg border border-[var(--color-border)] p-3 bg-[var(--color-surface-2)]/50">
              <div className="text-xs uppercase tracking-wide text-white/50">Brief</div>
              <div className="mt-2 text-sm text-white/85">
                {selected.brief?.summary ?? selected.run.briefSummary ?? "No summary available yet."}
              </div>
              {selected.brief?.confidence != null && (
                <div className="mt-1 text-xs text-white/45">Confidence: {Math.round(selected.brief.confidence * 100)}%</div>
              )}
              {!!selected.brief?.keyFindings?.length && (
                <ul className="mt-2 list-disc pl-5 text-xs text-white/75 space-y-1">
                  {selected.brief.keyFindings.map((f, i) => (
                    <li key={i}>{f}</li>
                  ))}
                </ul>
              )}
              {!!selected.brief?.recommendations?.length && (
                <ul className="mt-2 list-disc pl-5 text-xs text-cyan-200/80 space-y-1">
                  {selected.brief.recommendations.map((f, i) => (
                    <li key={i}>{f}</li>
                  ))}
                </ul>
              )}
            </div>

            <div className="rounded-lg border border-[var(--color-border)] p-3">
              <div className="text-xs uppercase tracking-wide text-white/50 mb-2">Review</div>
              {selected.review && (
                <div className="mb-3 text-xs text-white/45">
                  Current: {selected.review.decision} ({fmtDate(selected.review.reviewedAt)})
                  {selected.review.notes ? ` • ${selected.review.notes}` : ""}
                </div>
              )}

              <fetcher.Form method="post" className="flex flex-col sm:flex-row gap-2 sm:items-center">
                <input type="hidden" name="intent" value="review" />
                <input type="hidden" name="runId" value={selected.id} />
                <select name="decision" className="px-2 py-1.5 bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded text-xs text-white/80">
                  <option value="approve">approve</option>
                  <option value="needs_followup">needs_followup</option>
                  <option value="reject">reject</option>
                </select>
                <input name="notes" placeholder="Optional notes" className="flex-1 px-2 py-1.5 bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded text-xs text-white/80 placeholder:text-white/30" />
                <button type="submit" className="px-3 py-1.5 text-xs bg-[var(--color-accent)] text-white rounded-md hover:opacity-90">Save</button>
              </fetcher.Form>
            </div>

            <div>
              <div className="text-xs uppercase tracking-wide text-white/50 mb-2">
                Findings ({selected.findings.length})
              </div>
              <div className="space-y-2 max-h-[35vh] overflow-y-auto pr-1">
                {selected.findings.map((f) => (
                  <div key={f.id} className="rounded-md border border-[var(--color-border)] px-3 py-2 bg-[var(--color-surface-2)]/40">
                    <div className="text-xs text-white/45 mb-1">
                      {f.findingType}
                      {f.severity ? ` • ${f.severity}` : ""}
                      {f.confidence != null ? ` • ${Math.round(f.confidence * 100)}%` : ""}
                      {f.entityName ? ` • ${f.entityName}` : ""}
                    </div>
                    <div className="text-sm text-white/85">{f.claim}</div>
                    {f.evidenceQuote && <div className="mt-1 text-xs text-white/55">{f.evidenceQuote}</div>}
                    {f.sourceUrl && (
                      <a href={f.sourceUrl} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs text-[var(--color-accent)] hover:underline">
                        Source
                      </a>
                    )}
                  </div>
                ))}
                {selected.findings.length === 0 && (
                  <div className="text-sm text-white/40">No findings stored for this run.</div>
                )}
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
