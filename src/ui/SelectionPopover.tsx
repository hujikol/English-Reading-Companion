/**
 * The selection popover. This is the product.
 *
 * An Indonesian learner selects a word in a PDF and sees its meaning without
 * losing their place. Therefore:
 *
 *  - It renders from `PopoverState` in `ui/vocab/selectionPopover.ts` and owns no
 *    lookup logic of its own. Every rule that must hold is tested there.
 *  - Appearing runs ONE local IndexedDB read. It never makes a network request.
 *  - It does not take focus on appearance. Focus moves here only when the learner
 *    asks for it (the reader's keyboard activation), and it returns focus to the
 *    element that had it when it closes.
 *  - Escape dismisses. The learner's text selection is never cleared by this
 *    component.
 */

import { useCallback, useEffect, useId, useRef } from "react";

import {
  announceCard,
  announceExplain,
  announceSave,
  beginExplain,
  beginSave,
  canSave,
  dismissPopover,
  endExplain,
  endSave,
  failLookup,
  headwordDiffers,
  openPopover,
  requestExplain,
  resolveLookup,
  saveSelection,
  senseChoices,
  setMeaningDraft,
  setNoteDraft,
  summarize,
  type AiAvailability,
  type Lookup,
  type LookupSurface,
  type PopoverState,
  type SaveOutcome,
  type Selection,
} from "./vocab/selectionPopover.ts";

export type SelectionPopoverProps = {
  state: PopoverState;
  onStateChange: (next: PopoverState) => void;
  /** local dictionary read; injected so a miss never becomes a network path */
  lookupSurface: LookupSurface;
  store: Parameters<typeof saveSelection>[0]["store"];
  /** disabled by default: an unconfigured provider cannot be reached at all */
  ai?: AiAvailability;
  packAttribution?: { source: string; license: string } | null;
  onDismiss: (reason: "escape" | "outside" | "selection-change" | "scroll" | "action") => void;
  /** focus the card after a keyboard activation; never called on hover/selection */
  autoFocus?: boolean;
};

const POSITION_ABOVE = "bottom";

/** Keep the card inside the viewport without moving it under the learner's cursor. */
function placementFor(rect: { top: number; left: number; bottom: number; right: number }): { top: number; left: number; position: string } {
  const width = 340;
  const height = 260;
  const viewportWidth = typeof window === "undefined" ? 1024 : window.innerWidth;
  const viewportHeight = typeof window === "undefined" ? 768 : window.innerHeight;
  const left = Math.max(8, Math.min(rect.left, viewportWidth - width - 8));
  const above = rect.top - height - 12;
  return {
    left,
    top: above >= 8 ? rect.top : rect.bottom + 12,
    position: above >= 8 ? POSITION_ABOVE : "top",
  };
}

export function SelectionPopover(props: SelectionPopoverProps) {
  const { state, onStateChange, lookupSurface, store, ai, packAttribution, onDismiss, autoFocus } = props;
  const cardRef = useRef<HTMLDivElement | null>(null);
  const headingId = useId();
  const meaningId = useId();
  const sentenceId = useId();
  /** where focus was before the card took it, so it can be given back */
  const restoreTo = useRef<HTMLElement | null>(null);

  const open = state.open && state.selection !== null;

  // --- focus discipline: never steal it, always return it
  useEffect(() => {
    if (!open) return;
    if (autoFocus && cardRef.current) {
      restoreTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const first = cardRef.current.querySelector<HTMLElement>("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])");
      first?.focus();
    }
  }, [open, autoFocus]);

  const close = useCallback(
    (reason: "escape" | "outside" | "selection-change" | "scroll" | "action") => {
      restoreTo.current?.focus();
      restoreTo.current = null;
      onStateChange(dismissPopover(state));
      onDismiss(reason);
    },
    [onDismiss, onStateChange, state],
  );

  // Escape closes, from anywhere inside the card.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close("escape");
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, close]);

  // --- the one request this component can make: a LOCAL lookup, once per selection
  useEffect(() => {
    if (!open || state.selection === null || state.status !== "looking-up") return;
    let live = true;
    const requestId = state.requestId;
    lookupSurface(state.selection.surface)
      .then((result: Lookup) => {
        if (live) onStateChange(resolveLookup(state, requestId, result));
      })
      .catch((e: unknown) => {
        if (live) onStateChange(failLookup(state, requestId, e instanceof Error ? e.message : "Lookup failed."));
      });
    return () => {
      live = false;
    };
    // state.requestId is the identity of this selection; nothing else may re-trigger it
  }, [open, state.requestId, state.status, state.selection, lookupSurface, onStateChange, state]);

  const selection = state.selection;
  const summary = summarize(state.lookup, selection?.surface ?? "");

  /*
    Hook order is fixed. Every hook is above the early return, because a hook
    after `return null` is "rendered more hooks than during the previous render"
    the first time the card opens — and it fails exactly when the learner selects
    a word, which is the one moment the product must work.
  */
  const doSave = useCallback(() => {
    if (selection === null) return;
    onStateChange(beginSave(state));
    void saveSelection({
      store,
      selection,
      meaning: state.meaningDraft,
      ...(state.noteDraft === "" ? {} : { note: state.noteDraft }),
      ...(summary.kind === "match" ? { provenance: { kind: "dictionary" as const } } : { provenance: { kind: "manual" as const } }),
      ...(summary.kind === "match" && selection.surface !== summary.headword ? { lemma: summary.headword } : {}),
    }).then((outcome: SaveOutcome) => onStateChange(endSave(state, outcome)));
  }, [onStateChange, selection, state, store, summary]);

  const doExplain = useCallback(() => {
    if (selection === null) return;
    onStateChange(beginExplain(state));
    void requestExplain({
      availability: ai ?? { configured: false, reason: "No AI provider is configured." },
      selection,
      signal: new AbortController().signal,
    }).then((outcome) => onStateChange(endExplain(state, outcome)));
  }, [ai, onStateChange, selection, state]);

  if (!open || selection === null) return null;
  const senses = state.lookup !== null && state.lookup.found ? senseChoices(state.lookup.result, state.meaningDraft) : [];
  const miss = state.lookup !== null && !state.lookup.found ? summarize(state.lookup, selection.surface) : null;
  const placement = placementFor(selection.rect);
  const aiDisabled = ai === undefined || !ai.configured;

  return (
    <div
      ref={cardRef}
      className="absolute z-30 w-[22rem] rounded-xl border border-line bg-paper shadow-xl shadow-black/10 p-4 text-ink"
      role="dialog"
      aria-labelledby={headingId}
      aria-describedby={sentenceId}
      style={{ position: "absolute", top: `${placement.top}px`, left: `${placement.left}px`, maxWidth: "22rem" }}
      data-placement={placement.position}
      data-testid="selection-popover"
    >
      {/* Announced programmatically: a transient visual card is not announced on its own. */}
      <p role="status" aria-live="polite" className="sr-only">
        {announceCard(state, summary)}
      </p>
      <p role="status" aria-live="polite" className="sr-only">
        {state.save === null ? "" : announceSave(state.save)}
      </p>

      <div className="mb-3 flex items-start justify-between gap-2">
        <h2 id={headingId} className="text-lg font-semibold leading-tight text-ink break-words">
          {selection.surface}
        </h2>
        {summary.kind === "match" && (
          <span className="mt-1 block text-xs text-ink-soft">
            {summary.partOfSpeech !== null && <span className="mr-2 rounded bg-accent-soft px-1.5 py-0.5 font-medium text-accent">{summary.partOfSpeech}</span>}
            {headwordDiffers(
              { headword: summary.headword, normalizedForm: "", partOfSpeech: null, senses: [], matchedVia: summary.matchedVia },
              selection.surface,
            ) && <span className="italic">as {summary.headword}</span>}
          </span>
        )}
        {summary.kind === "candidate" && <span className="mt-1 block text-xs text-ink-soft">no exact entry — closest: {summary.headword}</span>}
        <button type="button" className="-mr-1 -mt-1 shrink-0 rounded p-1 text-lg leading-none text-ink-soft hover:bg-shell focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent" onClick={() => close("action")} aria-label="Close lookup">
          ×
        </button>
      </div>

      {state.status === "looking-up" && <p className="mb-3 text-sm text-ink-soft">Looking up…</p>}

      {state.status === "failed" && (
        <p className="mb-3 rounded-lg border border-danger/30 bg-danger/5 p-2 text-sm text-danger">
          The local dictionary could not be read: {state.lookupError}
        </p>
      )}

      {senses.length > 0 && (
        <ul className="mb-3 flex max-h-40 flex-col gap-1 overflow-y-auto" aria-label="Senses">
          {senses.map((sense) => (
            <li key={sense.senseId}>
              <button
                type="button"
                className="w-full rounded-lg border border-line px-3 py-2 text-left text-sm hover:border-accent hover:bg-accent-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent aria-pressed:border-accent aria-pressed:bg-accent-soft"
                aria-pressed={sense.selected}
                onClick={() => onStateChange(setMeaningDraft(state, sense.gloss))}
              >
                {sense.gloss}
              </button>
            </li>
          ))}
        </ul>
      )}

      {miss !== null && miss.kind === "none" && (
        <p className="mb-3 rounded-lg bg-shell p-2 text-sm text-ink-soft">
          <strong>{miss.reason.headline}</strong> {miss.reason.detail}
        </p>
      )}

      <label className="mb-3 block text-xs font-medium text-ink-soft" htmlFor={meaningId}>
        <span>Meaning you will save</span>
        <textarea
          id={meaningId}
          rows={2}
          value={state.meaningDraft}
          placeholder="Type the meaning in Indonesian or English"
          onChange={(e) => onStateChange(setMeaningDraft(state, e.target.value))}
        />
      </label>

      <label className="mb-3 block text-xs font-medium text-ink-soft" htmlFor={sentenceId}>
        <span>Original sentence</span>
        <output id={sentenceId} className="mt-1 block max-h-24 overflow-y-auto rounded-lg bg-shell p-2 font-read text-sm leading-relaxed text-ink">
          {selection.sentence === "" ? "No sentence captured for this selection." : selection.sentence}
        </output>
      </label>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40" onClick={doSave} disabled={!canSave(state)}>
          {state.savePending ? "Saving…" : "Save to vocabulary"}
        </button>
        {/*
          AI is reachable only by this click, and only when a provider exists.
          There is no hover path, no effect path, and no provider construction here.
        */}
        <button
          type="button"
          className="rounded-lg border border-line bg-paper px-3 py-2 text-sm font-medium text-ink hover:bg-shell focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40"
          onClick={doExplain}
          disabled={aiDisabled || state.explainPending}
          title={aiDisabled ? (ai !== undefined && !ai.configured ? ai.reason : "No AI provider is configured.") : "Explain this word with AI"}
          aria-describedby={aiDisabled ? `${headingId}-ai-note` : undefined}
        >
          {state.explainPending ? "Asking…" : "Explain with AI"}
        </button>
      </div>

      {aiDisabled && (
        <p id={`${headingId}-ai-note`} className="mt-2 block text-xs leading-relaxed text-ink-soft">
          AI is off. Configure a provider in Settings to enable it. Reading and saving work without it.
        </p>
      )}

      {state.explain !== null && (
        <p className="mt-2 block text-xs leading-relaxed text-ink-soft">
          {state.explain.kind === "explained"
            ? state.explain.result.naturalTranslation
            : state.explain.kind === "disabled"
              ? state.explain.reason
              : `The explanation failed: ${state.explain.message}`}
          <span className="sr-only">{announceExplain(state.explain)}</span>
        </p>
      )}

      <footer className="mt-3 flex items-center justify-between gap-2 border-t border-line pt-2 text-xs text-ink-soft">
        {packAttribution === null || packAttribution === undefined
          ? "Local lookup — no dictionary pack installed"
          : `${packAttribution.source} · ${packAttribution.license}`}
        {selection.positionLabel !== undefined && <span> · {selection.positionLabel}</span>}
      </footer>
    </div>
  );
}

/**
 * The reader-facing wrapper: owns the selection -> open transition.
 *
 * Kept separate from the card so the reader (Track D) can mount the card without
 * owning any of its behaviour.
 */
export function useSelectionPopover(
  current: PopoverState,
  setState: (next: PopoverState) => void,
): { state: PopoverState; show: (selection: Selection) => void; dismiss: () => void } {
  const show = useCallback(
    (selection: Selection) => setState(openPopover(current, selection)),
    [current, setState],
  );
  const dismiss = useCallback(() => setState(dismissPopover(current)), [current, setState]);
  return { state: current, show, dismiss };
}