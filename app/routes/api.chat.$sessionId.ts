import type { LoaderFunctionArgs } from "react-router";
import { pipelineEmitter, type PipelineEvent } from "~/lib/sse/emitter";

// GET /api/chat/:sessionId — Server-Sent Events stream for real-time pipeline progress
export async function loader({ params }: LoaderFunctionArgs) {
  const { sessionId } = params;
  if (!sessionId) {
    return new Response("sessionId required", { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          );
        } catch {
          // Stream already closed
        }
      };

      const handler = (event: PipelineEvent) => {
        send(event.type, event);
        if (event.type === "complete" || event.type === "error") {
          pipelineEmitter.off(sessionId, handler);
          try { controller.close(); } catch { /* already closed */ }
          clearInterval(heartbeat);
        }
      };

      pipelineEmitter.on(sessionId, handler);

      // Heartbeat every 20s to keep connection alive through proxies
      const heartbeat = setInterval(() => {
        send("heartbeat", { ts: Date.now() });
      }, 20_000);

      // Initial connected event
      send("connected", { sessionId });
    },
    cancel() {
      // Client disconnected — clean up listeners
      pipelineEmitter.removeAllListeners(sessionId);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // Disable nginx buffering if behind proxy
    },
  });
}
