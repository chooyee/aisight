import { useState, useRef, useEffect } from "react";
import { AppShell } from "~/components/layout/AppShell";
import { useSSEStream } from "~/components/chat/useSSEStream";

export default function Chat() {
  const [query, setQuery] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [maxResults, setMaxResults] = useState(10);
  const feedRef = useRef<HTMLDivElement>(null);

  const { events, status } = useSSEStream(sessionId);

  // Auto-scroll feed
  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: "smooth" });
  }, [events]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim() || submitting) return;

    setSubmitting(true);
    setSessionId(null);

    try {
      const res = await fetch("/api/crawl", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: query.trim(), maxResults }),
      });
      const data = await res.json() as { sessionId: string; runId: string };
      setSessionId(data.sessionId);
    } catch (err) {
      console.error(err);
    } finally {
      setSubmitting(false);
    }
  }

  const isRunning = status === "connecting" || status === "streaming";

  return (
    <AppShell>
      <div className="flex flex-col h-full max-w-3xl mx-auto p-6 gap-4">
        <div>
          <h1 className="text-xl font-semibold">Command & Control</h1>
          <p className="text-sm text-white/40 mt-0.5">
            Issue natural-language scraping commands
          </p>
        </div>

        {/* Event feed */}
        <div
          ref={feedRef}
          className="flex-1 min-h-0 overflow-y-auto bg-[var(--color-surface-1)] border border-[var(--color-border)] rounded-lg p-4 font-mono text-xs space-y-1"
        >
          {events.length === 0 && !isRunning && (
            <p className="text-white/30 text-center py-10">
              Enter a command below to start scraping
            </p>
          )}
          {events.map((ev, i) => {
            if (ev.type === "progress")
              return (
                <div key={i} className="text-white/60">
                  <span className="text-[var(--color-accent)]/70">[{ev.stage}]</span>{" "}
                  {ev.message}
                  {ev.percent !== undefined && (
                    <span className="text-white/30 ml-2">{ev.percent}%</span>
                  )}
                </div>
              );
            if (ev.type === "article")
              return (
                <div key={i} className="text-green-400/80">
                  ✓ article: <span className="text-white/70">{ev.title}</span>
                </div>
              );
            if (ev.type === "entity")
              return (
                <div key={i} className="text-blue-400/70">
                  ⬡ entity: <span className="text-white/70">{ev.name}</span>{" "}
                  <span className="text-white/30">({ev.entityType})</span>
                </div>
              );
            if (ev.type === "complete")
              return (
                <div key={i} className="text-green-400 font-semibold mt-2">
                  ✓ Complete — {ev.itemsCompleted}/{ev.itemsTotal} articles processed
                </div>
              );
            if (ev.type === "error")
              return (
                <div key={i} className="text-red-400">
                  ✗ Error: {ev.message}
                </div>
              );
            return null;
          })}
          {isRunning && (
            <div className="text-white/30 animate-pulse">▌</div>
          )}
        </div>

        {/* Input */}
        <form onSubmit={handleSubmit} className="space-y-3">
          <textarea
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder='e.g. "Find latest news on Maybank regarding capital stress" or "BNM regulatory actions 2026"'
            rows={3}
            disabled={isRunning}
            className="w-full px-4 py-3 bg-[var(--color-surface-1)] border border-[var(--color-border)] rounded-lg text-sm text-white/90 placeholder-white/30 focus:outline-none focus:border-[var(--color-accent)] resize-none disabled:opacity-50"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSubmit(e as never);
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
