import type { EntitySearchCandidate } from "~/lib/graphChat/search";

type PendingResolution = {
  candidates: EntitySearchCandidate[];
  createdAt: number;
  expiresAt: number;
};

const TTL_MS = 5 * 60 * 1000;
const pendingBySession = new Map<string, PendingResolution>();

function pruneExpired() {
  const now = Date.now();
  for (const [sessionId, pending] of pendingBySession.entries()) {
    if (pending.expiresAt <= now) {
      pendingBySession.delete(sessionId);
    }
  }
}

export function getPendingResolution(sessionId: string) {
  pruneExpired();
  return pendingBySession.get(sessionId) ?? null;
}

export function setPendingResolution(sessionId: string, candidates: EntitySearchCandidate[]) {
  pruneExpired();
  pendingBySession.set(sessionId, {
    candidates,
    createdAt: Date.now(),
    expiresAt: Date.now() + TTL_MS,
  });
}

export function clearPendingResolution(sessionId: string) {
  pendingBySession.delete(sessionId);
}
