import { useEffect, useRef, useState } from "react";
import type { PipelineEvent } from "~/lib/sse/emitter";

export type SSEStatus = "idle" | "connecting" | "streaming" | "complete" | "error";

export function useSSEStream(sessionId: string | null) {
  const [events, setEvents] = useState<PipelineEvent[]>([]);
  const [status, setStatus] = useState<SSEStatus>("idle");
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!sessionId) return;

    setStatus("connecting");
    setEvents([]);

    const es = new EventSource(`/api/chat/${sessionId}`);
    esRef.current = es;

    es.addEventListener("connected", () => setStatus("streaming"));

    es.addEventListener("progress", (e) => {
      setEvents((prev) => [...prev, JSON.parse(e.data) as PipelineEvent]);
    });

    es.addEventListener("article", (e) => {
      setEvents((prev) => [...prev, JSON.parse(e.data) as PipelineEvent]);
    });

    es.addEventListener("entity", (e) => {
      setEvents((prev) => [...prev, JSON.parse(e.data) as PipelineEvent]);
    });

    es.addEventListener("complete", (e) => {
      setEvents((prev) => [...prev, JSON.parse(e.data) as PipelineEvent]);
      setStatus("complete");
      es.close();
    });

    es.addEventListener("error", (e) => {
      setEvents((prev) => [...prev, JSON.parse((e as MessageEvent).data ?? "{}") as PipelineEvent]);
      setStatus("error");
      es.close();
    });

    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        setStatus((s) => s === "streaming" ? "error" : s);
      }
    };

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [sessionId]);

  return { events, status };
}
