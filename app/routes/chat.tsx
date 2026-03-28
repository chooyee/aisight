import { useState, useRef, useEffect } from "react";
import { AppShell } from "~/components/layout/AppShell";
import { useSSEStream } from "~/components/chat/useSSEStream";
import type { PipelineEvent } from "~/lib/sse/emitter";
import type { SSEStatus } from "~/components/chat/useSSEStream";

type HistoryEntry = {
  query: string;
  events: PipelineEvent[];
  status: SSEStatus;
};

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

function AssistantBubble({
  events,
  status,
}: {
  events: PipelineEvent[];
  status: SSEStatus;
}) {
  const isRunning = status === "connecting" || status === "streaming";

  // Separate progress/article/entity from terminal events
  const feedEvents = events.filter(
    (e) => e.type === "progress" || e.type === "article" || e.type === "entity"
  );
  const terminalEvent = events.find(
    (e) => e.type === "complete" || e.type === "error"
  );

  return (
    <div className="flex justify-start gap-3">
      {/* Avatar */}
      <div className="shrink-0 w-7 h-7 rounded-full bg-[var(--color-accent)]/20 border border-[var(--color-accent)]/30 flex items-center justify-center text-[10px] text-[var(--color-accent)] font-bold mt-0.5">
        AI
      </div>

      {/* Bubble */}
      <div className="max-w-[85%] rounded-2xl rounded-tl-sm bg-[var(--color-surface-1)] border border-[var(--color-border)] px-4 py-3 space-y-1 font-mono text-xs min-w-[200px]">
        {feedEvents.length === 0 && isRunning && (
          <div className="text-white/30">Initialising…</div>
        )}

        {feedEvents.map((ev, i) => (
          <EventLine key={i} ev={ev} />
        ))}

        {isRunning && (
          <div className="text-white/25 animate-pulse pt-0.5">▌</div>
        )}

        {terminalEvent && <EventLine ev={terminalEvent} />}
      </div>
    </div>
  );
}

export default function Chat() {
  const [query, setQuery] = useState("");
  const [currentQuery, setCurrentQuery] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [maxResults, setMaxResults] = useState(10);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const feedRef = useRef<HTMLDivElement>(null);

  const { events, status } = useSSEStream(sessionId);

  // When a run finishes, archive it to history
  useEffect(() => {
    if ((status === "complete" || status === "error") && currentQuery !== null) {
      setHistory((prev) => [...prev, { query: currentQuery, events, status }]);
      setCurrentQuery(null);
      setSessionId(null);
    }
  }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-scroll
  useEffect(() => {
    feedRef.current?.scrollTo({
      top: feedRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [events, history]);

  async function handleSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!query.trim() || submitting) return;

    const q = query.trim();
    setQuery("");
    setSubmitting(true);
    setCurrentQuery(q);
    setSessionId(null);

    try {
      const res = await fetch("/api/crawl", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q, maxResults }),
      });
      const data = (await res.json()) as { sessionId: string; runId: string };
      setSessionId(data.sessionId);
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

  const isRunning =
    submitting || status === "connecting" || status === "streaming";
  const showEmptyState = history.length === 0 && !currentQuery;

  return (
    <AppShell>
      <div className="flex flex-col h-full max-w-3xl mx-auto p-6 gap-4">
        <div>
          <h1 className="text-xl font-semibold">Command & Control</h1>
          <p className="text-sm text-white/40 mt-0.5">
            Issue natural-language scraping commands
          </p>
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
            <div key={i} className="space-y-3">
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
            <button
              type="submit"
              disabled={isRunning || !query.trim()}
              className="px-5 py-2 bg-[var(--color-accent)] text-white text-sm rounded-md hover:opacity-90 disabled:opacity-40 transition-opacity"
            >
              {isRunning ? "Running…" : "Execute ⌘↵"}
            </button>
          </div>
        </form>
      </div>
    </AppShell>
  );
}
