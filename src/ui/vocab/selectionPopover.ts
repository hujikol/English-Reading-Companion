/**
 * Selection-popover state machine.
 *
 * This is the product. The React view in `src/ui/SelectionPopover.tsx` is a thin
 * renderer of exactly this state; every rule that must hold lives here so it can
 * be tested without a DOM.
 *
 * Rules enforced by this module (IDEA.md sections 4, 9, 10, 11):
 *
 *  - Appearing never touches the network. The only request this module knows how
 *    to make is `lookupSurface`, which is a local IndexedDB read. AI is reachable
 *    only through `requestExplain`, and only when an AiAvailability says a
 *    provider is configured.
 *  - A late lookup result from a superseded selection is dropped by request id.
 *    A stale parser response must never move a popup or change the meaning of a
 *    newer selection (section 7).
 *  - `save` reports what actually happened. A rejected write is `{kind:"failed"}`
 *    and never `{kind:"saved"}` (section 11).
 */

import type { AppDB } from "../../../src/db/index.ts";
import type { Anchor, Explanation, LearningExplanation, Vocabulary, Occurrence } from "../../contracts/index.ts";
import type { Lookup, LookupResult } from "../../features/dictionary/lookup.ts";
import { capture, normalizeForm, type CaptureInput, type CaptureResult } from "../../features/vocabulary/capture.ts";

/** Selection-time geometry. Never persisted, never part of an Anchor (section 7). */
export type PopoverRect = { top: number; left: number; bottom: number; right: number };

/** One selection, fully described by the reader. */
export type Selection = {
  surface: string;
  /** the sentence the selection sits in, used as provenance and AI context */
  sentence: string;
  anchor: Anchor;
  documentId?: string;
  titleSnapshot: string;
  rect: PopoverRect;
  /** page or chapter label for the card footer; absent for formats with none */
  positionLabel?: string;
};

export type LookupStatus = "idle" | "looking-up" | "ready" | "miss" | "failed";

export type PopoverState = {
  /** false means dismissed; the view renders nothing */
  open: boolean;
  /** increments per selection, so a late response can be recognised as stale */
  requestId: number;
  selection: Selection | null;
  status: LookupStatus;
  lookup: Lookup | null;
  lookupError: string | null;
  /** the learner's chosen meaning: a dictionary gloss, or their own words */
  meaningDraft: string;
  noteDraft: string;
  /** the save outcome, verbatim. Never optimistically "saved". */
  save: SaveOutcome | null;
  savePending: boolean;
  explain: ExplainOutcome | null;
  explainPending: boolean;
  /** what was dismissed, and when, so the same selection cannot instantly reopen */
  dismissed: { surface: string; at: number } | null;
};

/**
 * How long a dismissal suppresses a reopen of the same surface.
 *
 * Escape produces a keydown AND a keyup. A reader that opens the popover on
 * selection settle — which it must, for Shift+Arrow keyboard selection — would
 * therefore reopen the card the instant Escape closed it. Suppressing a reopen
 * of the SAME surface for this long makes dismissal final without blocking a
 * deliberate re-selection of the same word a moment later.
 */
export const DISMISS_REOPEN_SUPPRESS_MS = 500;

// ------------------------------------------------------------------ save

export type SaveOutcome =
  | { kind: "saved"; result: CaptureResult }
  | { kind: "failed"; message: string };

export type SaveRequest = {
  store: AppDB;
  selection: Selection;
  meaning: string;
  note?: string;
  /** the pack version the senses came from; absent for a manual save */
  provenance?: { kind: "dictionary" | "ai" | "manual"; sourceVersion?: string; userEdited?: boolean };
  lemma?: string;
  explanation?: Omit<Explanation, "surface" | "createdAt">;
};

/**
 * The only path from a selection to a vocabulary row. Explicit, always.
 *
 * `capture` rejects an empty meaning and throws on a failed transaction; both
 * become `{kind:"failed"}`. There is no branch that reports a save that did not
 * happen.
 */
export async function saveSelection(req: SaveRequest): Promise<SaveOutcome> {
  const meaning = req.meaning.trim();
  if (meaning === "") return { kind: "failed", message: "Enter a meaning before saving." };
  const surface = req.selection.surface.trim();
  if (surface === "") return { kind: "failed", message: "Nothing was selected." };

  const input: CaptureInput = {
    surface,
    anchor: req.selection.anchor,
    titleSnapshot: req.selection.titleSnapshot,
    sentence: req.selection.sentence,
    meaning,
    ...(req.selection.documentId === undefined ? {} : { documentId: req.selection.documentId }),
    ...(req.note === undefined ? {} : { note: req.note }),
    ...(req.lemma === undefined ? {} : { lemma: req.lemma }),
    ...(req.provenance === undefined ? {} : { provenance: req.provenance }),
    ...(req.explanation === undefined ? {} : { explanation: req.explanation }),
  };

  try {
    return { kind: "saved", result: await capture(req.store, input) };
  } catch (e) {
    return { kind: "failed", message: e instanceof Error ? e.message : "The word could not be saved." };
  }
}

/** What the announcement says. A failure names the failure, never "Saved". */
export const announceSave = (o: SaveOutcome): string =>
  o.kind === "saved"
    ? o.result.kind === "attached"
      ? `Another example of "${o.result.vocabulary.surface}" was added.`
      : `Saved "${o.result.vocabulary.surface}" to your vocabulary.`
    : `Not saved: ${o.message}`;

// ------------------------------------------------------------------ explain

/**
 * Section 10: the provider is a small injected function, not a network client
 * this module owns. Nothing here constructs one.
 */
export type AiProvider = {
  id: string;
  model: string;
  promptVersion: string;
  explain(request: { surface: string; context: string; targetLanguage: "id"; signal: AbortSignal }): Promise<LearningExplanation>;
};

export type AiAvailability =
  | { configured: false; reason: string }
  | { configured: true; provider: AiProvider };

export type ExplainOutcome =
  | { kind: "explained"; result: LearningExplanation }
  | { kind: "failed"; message: string }
  | { kind: "disabled"; reason: string };

export type ExplainRequest = {
  availability: AiAvailability;
  selection: Selection;
  signal: AbortSignal;
};

/**
 * Explicit click only. With no provider configured this returns `{kind:"disabled"}`
 * without touching anything — the button is also rendered disabled, so a
 * programmatic call cannot reach a provider that does not exist.
 */
export async function requestExplain(req: ExplainRequest): Promise<ExplainOutcome> {
  if (!req.availability.configured) return { kind: "disabled", reason: req.availability.reason };
  try {
    const result = await req.availability.provider.explain({
      surface: req.selection.surface,
      context: req.selection.sentence,
      targetLanguage: "id",
      signal: req.signal,
    });
    return { kind: "explained", result };
  } catch (e) {
    return { kind: "failed", message: e instanceof Error ? e.message : "The explanation failed." };
  }
}

// ------------------------------------------------------------------ lookup

export type LookupSurface = (surface: string) => Promise<Lookup>;

export const initialPopoverState = (): PopoverState => ({
  open: false,
  requestId: 0,
  selection: null,
  status: "idle",
  lookup: null,
  lookupError: null,
  meaningDraft: "",
  noteDraft: "",
  save: null,
  savePending: false,
  explain: null,
  explainPending: false,
  dismissed: null,
});

/**
 * Open for a new selection. Any in-flight explain belongs to the previous
 * selection, so it is dropped rather than resolved against the new word.
 */
export function openPopover(state: PopoverState, selection: Selection, now: number = Date.now()): PopoverState {
  // Escape's own keyup must not undo the dismissal it just caused.
  const recentlyDismissed = state.dismissed;
  if (
    recentlyDismissed !== null &&
    recentlyDismissed.surface === selection.surface &&
    now - recentlyDismissed.at < DISMISS_REOPEN_SUPPRESS_MS
  ) {
    return state;
  }
  return {
    ...initialPopoverState(),
    open: true,
    requestId: state.requestId + 1,
    selection,
    status: "looking-up",
  };
}

/** Selection change, scroll, Escape, outside click. One transition. */
export const dismissPopover = (state: PopoverState, now: number = Date.now()): PopoverState =>
  state.open && state.selection !== null
    ? { ...initialPopoverState(), requestId: state.requestId, dismissed: { surface: state.selection.surface, at: now } }
    : state;

export function setMeaningDraft(state: PopoverState, meaning: string): PopoverState {
  return { ...state, meaningDraft: meaning, save: null };
}

export function setNoteDraft(state: PopoverState, note: string): PopoverState {
  return { ...state, noteDraft: note };
}

/**
 * Resolve a local lookup. `requestId` must be the one from `openPopover` for this
 * selection: a stale response changes nothing, so a slow earlier lookup can never
 * replace a newer selection's senses.
 */
export function resolveLookup(state: PopoverState, requestId: number, lookup: Lookup): PopoverState {
  if (requestId !== state.requestId || !state.open) return state;
  return { ...state, status: lookup.found ? "ready" : "miss", lookup, lookupError: null };
}

/** A local read that threw. A miss would read as "no such word", so this is distinct. */
export function failLookup(state: PopoverState, requestId: number, message: string): PopoverState {
  if (requestId !== state.requestId || !state.open) return state;
  return { ...state, status: "failed", lookup: null, lookupError: message };
}

export function beginSave(state: PopoverState): PopoverState {
  return { ...state, savePending: true, save: null };
}

export function endSave(state: PopoverState, outcome: SaveOutcome): PopoverState {
  return { ...state, savePending: false, save: outcome };
}

export function beginExplain(state: PopoverState): PopoverState {
  return { ...state, explainPending: true, explain: null };
}

export function endExplain(state: PopoverState, outcome: ExplainOutcome, requestId = state.requestId): PopoverState {
  if (!state.open || requestId !== state.requestId) return state;
  return { ...state, explainPending: false, explain: outcome };
}

// ------------------------------------------------------------------ derived

/** Save is offered only with a non-empty meaning and no write in flight. */
export const canSave = (state: PopoverState): boolean =>
  state.open && !state.savePending && state.meaningDraft.trim() !== "";

export type SenseChoice = { senseId: number; gloss: string; selected: boolean };

/**
 * Every sense of the matched headword, none of them marked correct. The card
 * never claims which sense applies in this sentence (section 9).
 */
export function senseChoices(result: LookupResult, chosenMeaning: string): SenseChoice[] {
  const chosen = normalizeForm(chosenMeaning);
  return result.senses.map((s) => ({ senseId: s.senseId, gloss: s.gloss, selected: normalizeForm(s.gloss) === chosen }));
}

export const headwordDiffers = (result: LookupResult, surface: string): boolean =>
  normalizeForm(result.headword) !== normalizeForm(surface);

export type MissReason =
  | { kind: "no-active-pack"; headline: string; detail: string }
  | { kind: "not-in-pack"; headline: string; detail: string }
  | { kind: "empty-surface"; headline: string; detail: string };

/**
 * A miss is a normal outcome and never invents a lemma or a translation. It
 * offers manual entry instead (section 4, "A miss says that no local entry was
 * found and offers manual meaning entry").
 */
export function describeMiss(lookup: Lookup): MissReason {
  if (lookup.found) return { kind: "empty-surface", headline: "", detail: "" };
  switch (lookup.reason) {
    case "no-active-pack":
      return {
        kind: "no-active-pack",
        headline: "No dictionary installed yet",
        detail: "Word lookup runs entirely on this device. Install a dictionary pack in Settings to get Indonesian meanings here.",
      };
    case "empty-surface":
      return { kind: "empty-surface", headline: "Nothing was selected", detail: "Select a word or phrase first." };
    case "not-in-pack":
      return {
        kind: "not-in-pack",
        headline: "No local entry found",
        detail: "This pack has no entry for the selection. Type the meaning you want to remember.",
      };
  }
}

export const announceExplain = (o: ExplainOutcome): string =>
  o.kind === "explained"
    ? "Explanation ready. It is a suggestion you can edit, not a dictionary fact."
    : o.kind === "disabled"
      ? `AI is not available: ${o.reason}`
      : `The explanation failed: ${o.message}`;

/** What the card says about the match, honestly, including when there is none. */
export type MatchSummary =
  | { kind: "match"; headword: string; matchedVia: LookupResult["matchedVia"]; partOfSpeech: string | null; senseCount: number }
  | { kind: "candidate"; headword: string; matchedVia: LookupResult["matchedVia"]; partOfSpeech: string | null }
  | { kind: "none"; reason: MissReason };

export function summarize(lookup: Lookup | null, surface: string): MatchSummary {
  if (lookup === null) return { kind: "none", reason: describeMiss({ found: false, reason: "empty-surface", candidates: [] }) };
  if (lookup.found)
    return {
      kind: "match",
      headword: lookup.result.headword,
      matchedVia: lookup.result.matchedVia,
      partOfSpeech: lookup.result.partOfSpeech,
      senseCount: lookup.result.senses.length,
    };
  const top = lookup.candidates[0];
  if (top)
    return { kind: "candidate", headword: top.headword, matchedVia: top.matchedVia, partOfSpeech: top.partOfSpeech };
  void surface;
  return { kind: "none", reason: describeMiss(lookup) };
}

/** Live-region text for the whole card, so the card is usable without sight of it. */
export function announceCard(state: PopoverState, summary: MatchSummary): string | null {
  if (!state.open || state.selection === null) return null;
  switch (summary.kind) {
    case "match": {
      const pos = summary.partOfSpeech === null ? "" : `, ${summary.partOfSpeech}`;
      return `${state.selection.surface}: matched ${summary.headword}${pos}, ${summary.senseCount} senses.`;
    }
    case "candidate":
      return `${state.selection.surface}: no exact entry. Closest in this pack is ${summary.headword}.`;
    case "none":
      return `${state.selection.surface}: ${summary.reason.headline}.`;
  }
}

export type { Vocabulary, Occurrence, Lookup };
