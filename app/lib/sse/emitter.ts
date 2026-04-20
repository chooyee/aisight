import { EventEmitter } from "node:events";

export type PipelineEvent =
  | { type: "progress"; stage: string; message: string; percent?: number }
  | { type: "article"; url: string; title: string; articleId?: string }
  | { type: "entity"; name: string; entityType: string }
  | { type: "finding"; claim: string; severity: string; sourceUrl: string; confidence: number }
  | { type: "brief_ready"; runId: string; summary: string; confidence: number; keyFindingsCount: number }
  | {
      type: "research_result";
      runId: string;
      summary: string;
      confidence: number;
      keyFindings: string[];
      recommendations: string[];
      sources: string[];
    }
  | { type: "complete"; runId: string; itemsTotal: number; itemsCompleted: number }
  | { type: "error"; message: string };

// Singleton in-process event bus — connects pipeline orchestrator to SSE routes.
// Safe because Express + React Router runs in a single Node.js process.
class PipelineEmitter extends EventEmitter {
  emit(sessionId: string, event: PipelineEvent): boolean {
    return super.emit(sessionId, event);
  }

  on(sessionId: string, listener: (event: PipelineEvent) => void): this {
    return super.on(sessionId, listener);
  }

  off(sessionId: string, listener: (event: PipelineEvent) => void): this {
    return super.off(sessionId, listener);
  }
}

export const pipelineEmitter = new PipelineEmitter();
pipelineEmitter.setMaxListeners(500);
