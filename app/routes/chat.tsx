import { useState, useRef, useEffect } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { desc, eq } from "drizzle-orm";
import { AppShell } from "~/components/layout/AppShell";
import { useSSEStream } from "~/components/chat/useSSEStream";
import { getDb } from "~/lib/db/client";
import { chatMessages, chatSessions } from "~/lib/db/schema";
import type { PipelineEvent } from "~/lib/sse/emitter";
import type { SSEStatus } from "~/components/chat/useSSEStream";

type HistoryEntry = {
  query: string;
  events: PipelineEvent[];
  status: SSEStatus;
};

type ConversationHistory = {
  sessionId: string;
  title: string;
  lastMessageAt: string;
  entries: HistoryEntry[];
};

type ResearchResultEvent = Extract<PipelineEvent, { type: "research_result" }>;

const ACTIVE_CHAT_STORAGE_KEY = "aisight:active-run";

type ActiveRunSnapshot = {
  query: string;
  sessionId: string | null;
  events: PipelineEvent[];
};

type StoredAssistantPayload = {
  kind: "assistant_result_v1";
  summary: string;
  confidence?: number;
  keyFindings?: string[];
  recommendations?: string[];
  sources?: string[];
  status?: "complete" | "error";
  itemsTotal?: number;
  itemsCompleted?: number;
};

function assistantPayloadToHistoryEntry(query: string, payload: StoredAssistantPayload): HistoryEntry {
  if (payload.status === "error") {
    return {
      query,
      status: "error",
      events: [{ type: "error", message: payload.summary }],
    };
  }

  const completeEvent: PipelineEvent = {
    type: "complete",
    runId: "stored",
    itemsTotal: payload.itemsTotal ?? 0,
    itemsCompleted: payload.itemsCompleted ?? payload.itemsTotal ?? 0,
  };

  // Standard mode: no key findings or recommendations — skip ResearchResponse
  const hasResearch = (payload.keyFindings?.length ?? 0) > 0 || (payload.recommendations?.length ?? 0) > 0;
  if (!hasResearch) {
    return { query, status: "complete", events: [completeEvent] };
  }

  return {
    query,
    status: "complete",
    events: [
      {
        type: "research_result",
        runId: "stored",
        summary: payload.summary,
        confidence: payload.confidence ?? 0,
        keyFindings: payload.keyFindings ?? [],
        recommendations: payload.recommendations ?? [],
        sources: payload.sources ?? [],
      },
      completeEvent,
    ],
  };
}

function parseStoredAssistantMessage(query: string, content: string): HistoryEntry {
  try {
    const parsed = JSON.parse(content) as Partial<StoredAssistantPayload>;
    if (parsed.kind === "assistant_result_v1" && typeof parsed.summary === "string") {
      return assistantPayloadToHistoryEntry(query, parsed as StoredAssistantPayload);
    }
  } catch {
    // Fall back to treating stored assistant content as a plain-text response.
  }

  return {
    query,
    status: "complete",
    events: [
      {
        type: "research_result",
        runId: "stored",
        summary: content,
        confidence: 0,
        keyFindings: [],
        recommendations: [],
        sources: [],
      },
      { type: "complete", runId: "stored", itemsTotal: 0, itemsCompleted: 0 },
    ],
  };
}

export async function loader(_: LoaderFunctionArgs) {
  const db = getDb();
  const sessions = await db
    .select()
    .from(chatSessions)
    .orderBy(desc(chatSessions.lastMessageAt), desc(chatSessions.createdAt))
    .limit(50);

  const conversations = (
    await Promise.all(
      sessions.map(async (session) => {
        const messages = await db
          .select()
          .from(chatMessages)
          .where(eq(chatMessages.sessionId, session.id))
          .orderBy(chatMessages.createdAt);

        const entries: HistoryEntry[] = [];
        let pendingUserQuery: string | null = null;

        for (const message of messages) {
          if (message.role === "user") {
            pendingUserQuery = message.content;
            continue;
          }

          if (message.role === "assistant" && pendingUserQuery) {
            entries.push(parseStoredAssistantMessage(pendingUserQuery, message.content));
            pendingUserQuery = null;
          }
        }

        if (entries.length === 0) {
          return null;
        }

        const latestEntry = entries[entries.length - 1];

        return {
          sessionId: session.id,
          title: latestEntry.query,
          lastMessageAt: session.lastMessageAt?.toISOString() ?? session.createdAt.toISOString(),
          entries,
        } satisfies ConversationHistory;
      })
    )
  ).filter((entry): entry is ConversationHistory => entry !== null);

  return { conversations };
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] px-4 py-2.5 rounded-2xl rounded-br-sm bg-[var(--color-accent)] text-white text-sm leading-relaxed whitespace-pre-wrap">
        {text}
      </div>
    </div>
  );
}

function EventLine({ ev }: { ev: PipelineEvent }) {
  if (ev.type === "progress")
    return (
      <div className="flex items-baseline gap-2 text-xs text-white/50">
        <span className="shrink-0 text-[var(--color-accent)]/60 font-mono">[{ev.stage}]</span>
        <span>{ev.message}</span>
        {ev.percent !== undefined && (
          <span className="text-white/25 font-mono">{ev.percent}%</span>
        )}
      </div>
    );

  if (ev.type === "article")
    return (
      <div className="flex items-center gap-2 text-xs">
        <span className="text-green-400 shrink-0">✓</span>
        <span className="text-green-400/80 font-medium">{ev.title}</span>
      </div>
    );

  if (ev.type === "entity")
    return (
      <div className="flex items-center gap-2 text-xs">
        <span className="text-blue-400/60 shrink-0">⬡</span>
        <span className="text-white/70">{ev.name}</span>
        <span className="text-white/30 text-[10px] px-1.5 py-0.5 rounded-full border border-white/10">
          {ev.entityType}
        </span>
      </div>
    );

  if (ev.type === "finding")
    return (
      <div className="flex items-start gap-2 text-xs">
        <span className="text-amber-400 shrink-0">!</span>
        <div className="text-amber-300/90">
          <span className="font-semibold">{ev.claim}</span>
          <span className="text-amber-100/60"> ({ev.severity}, {Math.round(ev.confidence * 100)}%)</span>
        </div>
      </div>
    );

  if (ev.type === "brief_ready")
    return (
      <div className="mt-2 text-xs rounded-md border border-cyan-400/25 bg-cyan-400/8 px-3 py-2 text-cyan-100/90">
        <div className="font-semibold text-cyan-300">Research Brief Ready</div>
        <div className="mt-1 text-cyan-100/80">{ev.summary}</div>
        <div className="mt-1 text-cyan-100/60">
          Confidence: {Math.round(ev.confidence * 100)}% • Key findings: {ev.keyFindingsCount}
        </div>
      </div>
    );

  if (ev.type === "complete")
    return (
      <div className="mt-2 flex items-center gap-2 text-sm font-semibold text-green-400">
        <span>✓</span>
        <span>
          Done — {ev.itemsCompleted}/{ev.itemsTotal} articles processed
        </span>
      </div>
    );

  if (ev.type === "error")
    return (
      <div className="mt-2 flex items-start gap-2 text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">
        <span className="shrink-0 font-bold">✗</span>
        <span>{ev.message}</span>
      </div>
    );

  return null;
}

function ResearchResponse({ result }: { result: ResearchResultEvent }) {
  return (
    <div className="mt-3 border-t border-[var(--color-border)] pt-3 space-y-3 font-sans text-sm leading-relaxed text-white/85">
      <div>
        <div className="text-[11px] uppercase tracking-wide text-white/40 mb-1">Research response</div>
        <p>{result.summary}</p>
      </div>

      {result.keyFindings.length > 0 && (
        <div>
          <div className="text-[11px] uppercase tracking-wide text-white/40 mb-1">Key findings</div>
          <ul className="list-disc pl-5 space-y-1 text-white/80">
            {result.keyFindings.map((finding, index) => (
              <li key={index}>{finding}</li>
            ))}
          </ul>
        </div>
      )}

      {result.recommendations.length > 0 && (
        <div>
          <div className="text-[11px] uppercase tracking-wide text-white/40 mb-1">Suggested follow-up</div>
          <ul className="list-disc pl-5 space-y-1 text-cyan-100/80">
            {result.recommendations.map((recommendation, index) => (
              <li key={index}>{recommendation}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 text-[11px] text-white/45">
        <span className="px-2 py-1 rounded-full border border-white/10 bg-white/5">
          Confidence: {Math.round(result.confidence * 100)}%
        </span>
      </div>

      {result.sources.length > 0 && (
        <div>
          <div className="text-[11px] uppercase tracking-wide text-white/40 mb-1">Sources</div>
          <div className="space-y-1">
            {result.sources.map((source) => (
              <a
                key={source}
                href={source}
                target="_blank"
                rel="noreferrer"
                className="block text-xs text-[var(--color-accent)] hover:underline break-all"
              >
                {source}
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function AssistantBubble({
  events,
  status,
}: {
  events: PipelineEvent[];
  status: SSEStatus;
}) {
  const isRunning = status === "connecting" || status === "streaming";
  const [showTrace, setShowTrace] = useState(true);

  const progressEvents = events.filter(
    (e) => e.type === "progress" || e.type === "article" || e.type === "entity" || e.type === "finding"
  );
  const researchResult = events.find(
    (e): e is ResearchResultEvent => e.type === "research_result"
  );
  const terminalEvent = events.find(
    (e) => e.type === "complete" || e.type === "error"
  );
  const traceEvents = [...progressEvents, ...(terminalEvent ? [terminalEvent] : [])];

  useEffect(() => {
    if (isRunning) {
      setShowTrace(true);
      return;
    }

    if (researchResult) {
      setShowTrace(false);
    }
  }, [isRunning, researchResult]);

  return (
    <div className="flex justify-start gap-3">
      {/* Avatar */}
      <div className="shrink-0 w-7 h-7 rounded-full bg-[var(--color-accent)]/20 border border-[var(--color-accent)]/30 flex items-center justify-center text-[10px] text-[var(--color-accent)] font-bold mt-0.5">
        AI
      </div>

      {/* Bubble */}
      <div className="max-w-[85%] rounded-2xl rounded-tl-sm bg-[var(--color-surface-1)] border border-[var(--color-border)] px-4 py-3 space-y-1 font-mono text-xs min-w-[200px]">
        {progressEvents.length === 0 && isRunning && !researchResult && (
          <div className="text-white/30">Initialising…</div>
        )}

        {researchResult ? (
          <>
            <ResearchResponse result={researchResult} />

            {traceEvents.length > 0 && (
              <div className="mt-3 border-t border-[var(--color-border)] pt-3 space-y-2">
                <button
                  type="button"
                  onClick={() => setShowTrace((value) => !value)}
                  className="text-[11px] font-sans text-white/45 hover:text-white/80"
                >
                  {showTrace ? "Hide research trace" : `Show research trace (${traceEvents.length})`}
                </button>

                {showTrace && (
                  <div className="space-y-1">
                    {traceEvents.map((ev, i) => (
                      <EventLine key={i} ev={ev} />
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        ) : (
          <>
            {progressEvents.map((ev, i) => (
              <EventLine key={i} ev={ev} />
            ))}

            {isRunning && (
              <div className="text-white/25 animate-pulse pt-0.5">▌</div>
            )}

            {terminalEvent && <EventLine ev={terminalEvent} />}
          </>
        )}
      </div>
    </div>
  );
}

export default function Chat() {
  const { conversations: initialConversations } = useLoaderData<typeof loader>();
  const [query, setQuery] = useState("");
  const [currentQuery, setCurrentQuery] = useState<string | null>(null);
  const [activeChatSessionId, setActiveChatSessionId] = useState<string | null>(
    initialConversations[0]?.sessionId ?? null
  );
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [historyDrawerOpen, setHistoryDrawerOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [maxResults, setMaxResults] = useState(10);
  const [sourceDomain, setSourceDomain] = useState("");
  const [dayRange, setDayRange] = useState(7);
  const [crawlDomainMode, setCrawlDomainMode] = useState(false);
  const [researchMode, setResearchMode] = useState(false);
  const [showResearchGuide, setShowResearchGuide] = useState(true);
  const [researchGoal, setResearchGoal] = useState("");
  const [minConfidence, setMinConfidence] = useState(0.65);
  const [conversations, setConversations] = useState<ConversationHistory[]>(initialConversations);
  const [history, setHistory] = useState<HistoryEntry[]>(initialConversations[0]?.entries ?? []);
  const [historyHydrated, setHistoryHydrated] = useState(false);
  const [restoredActiveEvents, setRestoredActiveEvents] = useState<PipelineEvent[]>([]);
  const feedRef = useRef<HTMLDivElement>(null);
  const historyRefs = useRef<Array<HTMLDivElement | null>>([]);

  const centralBankExamples = [
    {
      label: "Property and construction stress transmission",
      query: "Find signs of construction project delays, unsold property overhang, contractor failures, and spillover risks to banks in Malaysia",
      domain: "thestar.com.my",
      goal: "Assess whether property and construction stress could transmit into banking-sector credit losses and broader financial instability",
    },
    {
      label: "Funding stress and liquidity pressure",
      query: "Find signs of deposit outflows, refinancing stress, wholesale funding pressure, and liquidity concerns affecting banks or major non-bank lenders in Malaysia",
      domain: "bnm.gov.my",
      goal: "Identify early warnings of liquidity stress that could threaten confidence and financial stability",
    },
    {
      label: "NPL deterioration and contagion",
      query: "Find news about rising non-performing loans, debt restructuring, large borrower distress, and contagion risk to banks in Malaysia",
      domain: "theedgemalaysia.com",
      goal: "Track asset-quality deterioration that could weaken bank resilience and amplify systemic stress",
    },
  ] as const;

  const entityResearchExamples = [
    {
      label: "Bank-specific liquidity stress",
      query: "Research whether Maybank is facing deposit outflows, refinancing pressure, asset-quality deterioration, or market confidence issues that could affect financial stability",
      domain: "theedgemalaysia.com",
      goal: "Assess whether stress in a major bank could propagate through funding markets or weaken system-wide confidence",
    },
    {
      label: "Borrower concentration risk",
      query: "Research whether Sunway Berhad or related construction entities are experiencing project delays, leverage stress, refinancing pressure, or defaults that could materially affect lender balance sheets",
      domain: "thestar.com.my",
      goal: "Determine whether distress in a large borrower group could transmit concentrated losses into the banking system",
    },
    {
      label: "Non-bank contagion risk",
      query: "Research whether major shadow banking, property, or non-bank financial entities in Malaysia are showing liquidity stress, covenant breaches, or disorderly deleveraging that could spill over to banks",
      domain: "bloomberg.com",
      goal: "Identify contagion channels from large non-bank entities into core financial institutions and markets",
    },
  ] as const;

  const { events, status } = useSSEStream(sessionId, restoredActiveEvents);

  useEffect(() => {
    try {
      const activeRaw = window.localStorage.getItem(ACTIVE_CHAT_STORAGE_KEY);
      if (activeRaw) {
        const parsedActive = JSON.parse(activeRaw) as Partial<ActiveRunSnapshot>;
        if (typeof parsedActive.query === "string") {
          setCurrentQuery(parsedActive.query);
          const restoredSessionId = typeof parsedActive.sessionId === "string" ? parsedActive.sessionId : null;
          setSessionId(restoredSessionId);
          setActiveChatSessionId(restoredSessionId);
          setRestoredActiveEvents(Array.isArray(parsedActive.events) ? parsedActive.events : []);
        }
      }
    } catch {
      // Ignore malformed localStorage payloads and continue with empty history.
    } finally {
      setHistoryHydrated(true);
    }
  }, []);

  // When a run finishes, archive it to history
  useEffect(() => {
    const hasTerminalEvent = events.some(
      (event) => event.type === "complete" || event.type === "error"
    );

    if ((status === "complete" || status === "error") && currentQuery !== null && hasTerminalEvent) {
      const nextEntry: HistoryEntry = { query: currentQuery, events, status };
      const resolvedSessionId = sessionId ?? activeChatSessionId ?? `local-${Date.now()}`;

      setHistory((prev) => [...prev, nextEntry]);
      setConversations((prev) => {
        const existingIndex = prev.findIndex((conversation) => conversation.sessionId === resolvedSessionId);
        const updatedConversation: ConversationHistory = existingIndex >= 0
          ? {
              ...prev[existingIndex],
              title: nextEntry.query,
              lastMessageAt: new Date().toISOString(),
              entries: [...prev[existingIndex].entries, nextEntry],
            }
          : {
              sessionId: resolvedSessionId,
              title: nextEntry.query,
              lastMessageAt: new Date().toISOString(),
              entries: [nextEntry],
            };

        const remaining = prev.filter((conversation) => conversation.sessionId !== resolvedSessionId);
        return [updatedConversation, ...remaining];
      });

      setCurrentQuery(null);
      setSessionId(null);
      setActiveChatSessionId(resolvedSessionId);
      setRestoredActiveEvents([]);
      if (historyHydrated) {
        window.localStorage.removeItem(ACTIVE_CHAT_STORAGE_KEY);
      }
    }
  }, [activeChatSessionId, currentQuery, events, historyHydrated, sessionId, status]);

  // Auto-scroll
  useEffect(() => {
    feedRef.current?.scrollTo({
      top: feedRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [events, history]);

  useEffect(() => {
    if (!historyHydrated) return;

    if (!currentQuery) {
      window.localStorage.removeItem(ACTIVE_CHAT_STORAGE_KEY);
      return;
    }

    const snapshot: ActiveRunSnapshot = {
      query: currentQuery,
      sessionId,
      events,
    };

    window.localStorage.setItem(ACTIVE_CHAT_STORAGE_KEY, JSON.stringify(snapshot));
  }, [currentQuery, events, historyHydrated, sessionId]);

  useEffect(() => {
    if (!historyDrawerOpen) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setHistoryDrawerOpen(false);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [historyDrawerOpen]);

  useEffect(() => {
    if (!researchMode) return;

    if (currentQuery || history.length > 0 || status === "streaming" || status === "complete") {
      setShowResearchGuide(false);
    }
  }, [currentQuery, history.length, researchMode, status]);

  async function handleSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!query.trim() || submitting) return;

    const q = query.trim();
    setQuery("");
    setSubmitting(true);
    setCurrentQuery(q);
    setSessionId(null);
    setShowResearchGuide(false);

    try {
      const res = await fetch("/api/crawl", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: q,
          ...(activeChatSessionId ? { sessionId: activeChatSessionId } : {}),
          maxResults,
          dayRange,
          ...(sourceDomain.trim() ? { sourceDomain: sourceDomain.trim() } : {}),
          researchMode,
          ...(researchGoal.trim() ? { researchGoal: researchGoal.trim() } : {}),
          minConfidence,
        }),
      });
      const data = (await res.json()) as { sessionId: string; runId: string };
      setSessionId(data.sessionId);
      setActiveChatSessionId(data.sessionId);
    } catch (err) {
      setHistory((prev) => [
        ...prev,
        {
          query: q,
          events: [{ type: "error", message: "Failed to connect to server." }],
          status: "error",
        },
      ]);
      setCurrentQuery(null);
    } finally {
      setSubmitting(false);
    }
  }

  function startNewChat() {
    if (isRunning) return;

    setActiveChatSessionId(null);
    setSessionId(null);
    setCurrentQuery(null);
    setRestoredActiveEvents([]);
    setHistory([]);
    setQuery("");
    setHistoryDrawerOpen(false);
    if (historyHydrated) {
      window.localStorage.removeItem(ACTIVE_CHAT_STORAGE_KEY);
    }
  }

  function openConversation(conversation: ConversationHistory) {
    if (isRunning) return;

    setActiveChatSessionId(conversation.sessionId);
    setSessionId(null);
    setCurrentQuery(null);
    setRestoredActiveEvents([]);
    setHistory(conversation.entries);
    setHistoryDrawerOpen(false);
  }

  const isRunning =
    submitting || status === "connecting" || status === "streaming";
  const showEmptyState = history.length === 0 && !currentQuery;
  const historyItems = conversations;

  return (
    <AppShell>
      <div className="relative h-full">
        <div className="flex flex-col h-full max-w-3xl mx-auto p-6 gap-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-xl font-semibold">Command & Control</h1>
              <p className="text-sm text-white/40 mt-0.5">
                Issue natural-language scraping commands
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={startNewChat}
                disabled={isRunning}
                className="px-3 py-1.5 text-xs rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] text-white/80 hover:text-white hover:bg-[var(--color-surface-2)] disabled:opacity-40"
              >
                New chat
              </button>
              <button
                type="button"
                onClick={() => setHistoryDrawerOpen(true)}
                className="px-3 py-1.5 text-xs rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] text-white/80 hover:text-white hover:bg-[var(--color-surface-2)]"
              >
                History ({historyItems.length})
              </button>
            </div>
          </div>

        {/* Chat feed */}
        <div
          ref={feedRef}
          className="flex-1 min-h-0 overflow-y-auto space-y-4 pr-1"
        >
          {showEmptyState && (
            <p className="text-white/30 text-center text-sm py-20">
              Enter a command below to start scraping
            </p>
          )}

          {/* History (completed runs) */}
          {history.map((entry, i) => (
            <div
              key={i}
              ref={(el) => {
                historyRefs.current[i] = el;
              }}
              className="space-y-3"
            >
              <UserBubble text={entry.query} />
              <AssistantBubble events={entry.events} status={entry.status} />
            </div>
          ))}

          {/* Active run */}
          {currentQuery && (
            <div className="space-y-3">
              <UserBubble text={currentQuery} />
              {(sessionId || submitting) && (
                <AssistantBubble events={events} status={status} />
              )}
            </div>
          )}
        </div>

        {/* Input */}
        <form onSubmit={handleSubmit} className="space-y-3">
          <textarea
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder='e.g. "Find latest news on Maybank regarding capital stress"'
            rows={3}
            disabled={isRunning}
            className="w-full px-4 py-3 bg-[var(--color-surface-1)] border border-[var(--color-border)] rounded-lg text-sm text-white/90 placeholder-white/30 focus:outline-none focus:border-[var(--color-accent)] resize-none disabled:opacity-50"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey))
                handleSubmit(e as never);
            }}
          />
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4 flex-wrap">
              <label className="flex items-center gap-2 text-xs text-white/50">
                Max results:
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={maxResults}
                  onChange={(e) => setMaxResults(Number(e.target.value))}
                  className="w-14 px-2 py-1 bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded text-white/80 text-xs focus:outline-none"
                />
              </label>
              <label className="flex items-center gap-2 text-xs text-white/50">
                <input
                  type="checkbox"
                  checked={crawlDomainMode}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setCrawlDomainMode(checked);
                    if (checked) {
                      setDayRange(30);
                      setMaxResults(15);
                    } else {
                      setDayRange(7);
                      setMaxResults(10);
                      setSourceDomain("");
                    }
                  }}
                  disabled={isRunning}
                />
                Crawl domain
              </label>
              <label className="flex items-center gap-2 text-xs text-white/50">
                <input
                  type="checkbox"
                  checked={researchMode}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setResearchMode(checked);
                    setShowResearchGuide(checked && history.length === 0 && currentQuery === null);
                  }}
                  disabled={isRunning}
                />
                Research mode
              </label>
              {researchMode && (
                <button
                  type="button"
                  onClick={() => setShowResearchGuide((value) => !value)}
                  className="text-xs text-white/45 hover:text-white/80"
                >
                  {showResearchGuide ? "Hide guide" : "Show guide"}
                </button>
              )}
            </div>
            <button
              type="submit"
              disabled={isRunning || !query.trim()}
              className="px-5 py-2 bg-[var(--color-accent)] text-white text-sm rounded-md hover:opacity-90 disabled:opacity-40 transition-opacity"
            >
              {isRunning ? "Running…" : "Execute ⌘↵"}
            </button>
          </div>

          {crawlDomainMode && (
            <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-[var(--color-accent)]/30 bg-[var(--color-accent)]/5">
              <span className="text-xs text-[var(--color-accent)]/70 font-medium shrink-0">Domain crawl</span>
              <label className="flex items-center gap-2 text-xs text-white/60 flex-1">
                Site:
                <input
                  type="text"
                  value={sourceDomain}
                  onChange={(e) => setSourceDomain(e.target.value)}
                  placeholder="e.g. thestar.com.my"
                  disabled={isRunning}
                  className="flex-1 px-2 py-1 bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded text-white/80 text-xs placeholder-white/25 focus:outline-none focus:border-[var(--color-accent)] disabled:opacity-50"
                />
              </label>
              <label className="flex items-center gap-2 text-xs text-white/60 shrink-0">
                Days back:
                <input
                  type="number"
                  min={1}
                  max={365}
                  value={dayRange}
                  onChange={(e) => setDayRange(Number(e.target.value))}
                  disabled={isRunning}
                  className="w-16 px-2 py-1 bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded text-white/80 text-xs focus:outline-none"
                />
              </label>
            </div>
          )}

          {researchMode && (
            <div className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="text-xs text-white/50 flex flex-col gap-1">
                  Research goal
                  <input
                    type="text"
                    value={researchGoal}
                    onChange={(e) => setResearchGoal(e.target.value)}
                    placeholder="e.g. Detect construction project delay risks"
                    disabled={isRunning}
                    className="px-2 py-1.5 bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded text-white/80 text-xs placeholder-white/25 focus:outline-none focus:border-[var(--color-accent)] disabled:opacity-50"
                  />
                </label>
                <label className="text-xs text-white/50 flex flex-col gap-1">
                  Min confidence (0-1)
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={minConfidence}
                    onChange={(e) => setMinConfidence(Number(e.target.value))}
                    disabled={isRunning}
                    className="px-2 py-1.5 bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded text-white/80 text-xs focus:outline-none"
                  />
                </label>
              </div>

              {showResearchGuide && (
                <div className="space-y-3">
                  <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 p-3">
                    <div className="text-[11px] uppercase tracking-wide text-white/45 mb-2">
                      Tavily research examples (financial stability)
                    </div>
                    <div className="space-y-2">
                      {centralBankExamples.map((ex) => (
                        <button
                          key={ex.label}
                          type="button"
                          disabled={isRunning}
                          onClick={() => {
                            setQuery(ex.query);
                            setSourceDomain(ex.domain);
                            setResearchGoal(ex.goal);
                          }}
                          className="w-full text-left px-3 py-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] hover:bg-[var(--color-surface-1)]/70 disabled:opacity-50"
                        >
                          <div className="text-xs font-medium text-white/85">{ex.label}</div>
                          <div className="text-[11px] text-white/45 mt-0.5">{ex.domain} • {ex.goal}</div>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 p-3">
                    <div className="text-[11px] uppercase tracking-wide text-white/45 mb-2">
                      Entity-based research examples
                    </div>
                    <div className="space-y-2">
                      {entityResearchExamples.map((ex) => (
                        <button
                          key={ex.label}
                          type="button"
                          disabled={isRunning}
                          onClick={() => {
                            setQuery(ex.query);
                            setSourceDomain(ex.domain);
                            setResearchGoal(ex.goal);
                          }}
                          className="w-full text-left px-3 py-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] hover:bg-[var(--color-surface-1)]/70 disabled:opacity-50"
                        >
                          <div className="text-xs font-medium text-white/85">{ex.label}</div>
                          <div className="text-[11px] text-white/45 mt-0.5">{ex.domain} • {ex.goal}</div>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </form>
      </div>

      {historyDrawerOpen && (
        <button
          type="button"
          aria-label="Close history drawer"
          onClick={() => setHistoryDrawerOpen(false)}
          className="absolute inset-0 bg-black/50"
        />
      )}

      <aside
        className={`absolute right-0 top-0 h-full w-full max-w-sm border-l border-[var(--color-border)] bg-[var(--color-surface-1)] shadow-xl transition-transform duration-200 z-10 ${historyDrawerOpen ? "translate-x-0" : "translate-x-full"}`}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
          <div>
            <h2 className="text-sm font-semibold text-white/90">Chat History</h2>
            <p className="text-[11px] text-white/45">Recent chat sessions</p>
          </div>
          <button
            type="button"
            onClick={() => setHistoryDrawerOpen(false)}
            className="px-2 py-1 text-xs text-white/60 hover:text-white"
          >
            Close
          </button>
        </div>

        <div className="h-[calc(100%-57px)] overflow-y-auto p-3 space-y-2">
          <button
            type="button"
            onClick={startNewChat}
            disabled={isRunning}
            className="w-full text-left p-3 rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-surface-2)]/20 hover:bg-[var(--color-surface-2)] disabled:opacity-40"
          >
            <div className="text-xs font-medium text-white/85">Start a new chat</div>
            <div className="text-[11px] text-white/45 mt-0.5">Create a fresh research conversation</div>
          </button>

          {historyItems.length === 0 && (
            <div className="text-sm text-white/40 p-2">No saved chats yet.</div>
          )}

          {historyItems.map((conversation) => {
            const latestEntry = conversation.entries[conversation.entries.length - 1];
            const statusColor =
              latestEntry?.status === "complete"
                ? "text-green-300 border-green-400/30 bg-green-400/10"
                : "text-red-300 border-red-400/30 bg-red-400/10";
            const findingCount = conversation.entries.reduce(
              (count, entry) => count + entry.events.filter((ev) => ev.type === "finding").length,
              0
            );
            const briefCount = conversation.entries.reduce(
              (count, entry) => count + entry.events.filter((ev) => ev.type === "brief_ready").length,
              0
            );
            const isActive = conversation.sessionId === activeChatSessionId;

            return (
              <button
                key={conversation.sessionId}
                type="button"
                onClick={() => openConversation(conversation)}
                disabled={isRunning}
                className={`w-full text-left p-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 hover:bg-[var(--color-surface-2)] disabled:opacity-40 ${isActive ? "ring-1 ring-[var(--color-accent)]" : ""}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className={`text-[10px] uppercase px-1.5 py-0.5 rounded border ${statusColor}`}>
                    {latestEntry?.status ?? "complete"}
                  </span>
                  <span className="text-[10px] text-white/40">Turns: {conversation.entries.length}</span>
                </div>
                <div className="mt-2 text-xs text-white/85 line-clamp-3">{conversation.title}</div>
                <div className="mt-2 text-[10px] text-white/45">
                  Findings: {findingCount} • Briefs: {briefCount}
                </div>
                <div className="mt-1 text-[10px] text-white/35">
                  {conversation.lastMessageAt ? new Date(conversation.lastMessageAt).toLocaleString() : ""}
                </div>
              </button>
            );
          })}
        </div>
      </aside>
      </div>
    </AppShell>
  );
}
