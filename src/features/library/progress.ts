/**
 * Progress writes. Section 13: debounce ~1s during movement, save on page and
 * visibility changes, do not rely on unload, and never show Saved before the
 * write actually succeeded. A revision counter detects a stale tab.
 *
 * Pure: the writer is injected, so this module has no Dexie and no timers of
 * its own beyond the debounce it hands to the caller.
 */

import type { Locator } from "../../contracts/index.ts";

export const MOVEMENT_DEBOUNCE_MS = 1000;

export type SaveOutcome =
  | { kind: "saved"; record: ProgressRow }
  /** another tab wrote a newer location; this write was refused, not lost silently */
  | { kind: "conflict"; currentRevision: number }
  | { kind: "failed"; message: string };

export type ProgressRow = {
  documentId: string;
  locator: Locator;
  progression: number;
  updatedAt: number;
  revision: number;
};

/** The single write surface the tracker needs. Implemented over AppDB.progress by the caller. */
export type ProgressStore = {
  read(documentId: string): Promise<ProgressRow | undefined>;
  /** must reject rather than clobber when the stored revision is newer */
  write(row: ProgressRow, expectedRevision: number): Promise<void>;
};

export type ProgressWrite = (documentId: string, locator: Locator, progression: number) => Promise<SaveOutcome>;

export type ProgressState = {
  documentId: string;
  /** persisted location, or undefined when nothing has been written yet */
  lastWritten: Locator | undefined;
  /** pending debounced write */
  pending: { locator: Locator; progression: number } | undefined;
  /** the last outcome, shown verbatim by the UI. Never optimistically "saved". */
  lastOutcome: SaveOutcome | undefined;
  revision: number;
};

export const initialProgressState = (documentId: string, restored?: ProgressRow): ProgressState => ({
  documentId,
  lastWritten: restored?.locator,
  pending: undefined,
  lastOutcome: undefined,
  revision: restored?.revision ?? 0,
});

const fraction = (p: number): number => (p < 0 ? 0 : p > 1 ? 1 : p);

/**
 * Append a revision. Tab A at revision 3 and tab B at revision 3 both write 4;
 * the store rejects the second because its expectation no longer holds, so the
 * stale tab cannot overwrite the newer location.
 */
export const bumpRevision = (r: number): number => r + 1;

export async function persistProgress(
  state: ProgressState,
  next: { locator: Locator; progression: number },
  store: ProgressStore,
  now: number = Date.now(),
): Promise<{ state: ProgressState; outcome: SaveOutcome }> {
  const expected = state.revision;
  const row: ProgressRow = {
    documentId: state.documentId,
    locator: next.locator,
    progression: fraction(next.progression),
    updatedAt: now,
    revision: expected + 1,
  };
  try {
    await store.write(row, expected);
  } catch (e) {
    if (e instanceof ProgressConflictError) {
      const outcome: SaveOutcome = { kind: "conflict", currentRevision: e.currentRevision };
      // lastWritten keeps the position that is actually durable
      return { state: { ...state, pending: undefined, lastOutcome: outcome, revision: e.currentRevision }, outcome };
    }
    const outcome: SaveOutcome = { kind: "failed", message: e instanceof Error ? e.message : "Progress could not be saved." };
    // a failed write leaves the previous durable position visible and unsaved
    return { state: { ...state, pending: undefined, lastOutcome: outcome }, outcome };
  }
  const outcome: SaveOutcome = { kind: "saved", record: row };
  return {
    state: {
      documentId: state.documentId,
      lastWritten: row.locator,
      pending: undefined,
      lastOutcome: outcome,
      revision: row.revision,
    },
    outcome,
  };
}

export class ProgressConflictError extends Error {
  constructor(readonly currentRevision: number) {
    super(`progress revision conflict; stored revision is ${currentRevision}`);
    this.name = "ProgressConflictError";
  }
}

/**
 * Movement during a continuous scroll: keep only the newest pending write, and
 * report the write as outstanding until it resolves. Saved means saved.
 */
export function queueProgress(state: ProgressState, locator: Locator, progression: number): ProgressState {
  return { ...state, pending: { locator, progression } };
}

/** A pending write that has not been persisted is by definition not Saved. */
export const isSavedLocally = (s: ProgressState): boolean => s.pending === undefined && s.lastOutcome?.kind === "saved";

/** which page a locator points at, for the "page changed" flush */
export const pageOf = (l: Locator): number | undefined => (l.kind === "pdf" ? l.pageIndex : undefined);

export const samePosition = (a: Locator | undefined, b: Locator | undefined): boolean => {
  if (a === undefined || b === undefined) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === "pdf" && b.kind === "pdf") return a.pageIndex === b.pageIndex && a.pageFraction === b.pageFraction;
  if (a.kind === "epub" && b.kind === "epub") return a.spineHref === b.spineHref && a.cfi === b.cfi;
  return a.kind === "text" && b.kind === "text" && a.blockId === b.blockId && a.start === b.start;
};

/**
 * Whether a change must be flushed immediately instead of debounced: a page or
 * chapter boundary, a visibility change, or a first position.
 */
export function mustFlushNow(
  prev: Locator | undefined,
  next: Locator,
  reason: "move" | "page-change" | "visibility-change" | "close",
): boolean {
  if (reason !== "move") return true;
  if (prev === undefined) return true;
  if (pageOf(prev) !== pageOf(next)) return true;
  return prev.kind !== next.kind;
}
