/**
 * Section 14: every request carries `generation`; increment on close/reopen and
 * ignore responses from older generations.
 *
 * Section 7 closes the loop: "A stale parser response must never move a popup or
 * change the meaning of a newer selection." That is a UI-state guarantee, so the
 * guard is a pure state machine plus one applicator that the caller wires to its
 * store. No timers, no promises, no worker handles in here.
 *
 * A guard is per document. Two open documents must not invalidate each other.
 */

export type Generation = number;

export type GenerationGuard = {
  documentId: string;
  current: Generation;
};

export const openGuard = (documentId: string): GenerationGuard => ({ documentId, current: 1 });

/** Close or reopen the document. Every earlier response is now stale. */
export const bumpGeneration = (guard: GenerationGuard): GenerationGuard => ({
  ...guard,
  current: guard.current + 1,
});

/** A response is current only if it is the same document AND not older. */
export const isCurrent = (guard: GenerationGuard, response: { documentId: string; generation: number }): boolean =>
  response.documentId === guard.documentId && response.generation >= guard.current;

/**
 * Out-of-order arrival: responses are scored in whatever order they land, and a
 * late older one is refused. The caller owns delivery, so this is a classifier
 * the reducer iterates over — it never schedules or reorders anything itself.
 */
export type StaleEvent = { requestId: string; generation: number; accepted: boolean; reason: string };

export function handleResponses(
  guard: GenerationGuard,
  responses: ReadonlyArray<{ requestId: string; documentId: string; generation: number }>,
): { guard: GenerationGuard; events: StaleEvent[] } {
  const events: StaleEvent[] = [];
  for (const r of responses) {
    if (r.documentId !== guard.documentId)
      events.push({ requestId: r.requestId, generation: r.generation, accepted: false, reason: "foreign-document" });
    else if (r.generation < guard.current)
      events.push({ requestId: r.requestId, generation: r.generation, accepted: false, reason: "stale-generation" });
    else events.push({ requestId: r.requestId, generation: r.generation, accepted: true, reason: "current" });
  }
  return { guard, events };
}
