/**
 * The core loop, end to end, over the real Track C/F logic:
 *   selection -> local lookup -> card -> explicit save -> vocabulary row -> review card -> grade.
 *
 * No DOM and no dictionary pack: `lookup` is the real function with the real miss
 * path, which is exactly the state the app ships in until a pack is installed.
 */

import { withFailingTransaction } from "../../faults.ts";
import { db, type AppDB } from "../../../src/db/index.ts";
import { beforeEach, describe, expect, it } from "vitest";

import type { Anchor } from "../../../src/contracts/index.ts";
import type { Lookup } from "../../../src/features/dictionary/lookup.ts";
import { capture } from "../../../src/features/vocabulary/capture.ts";
import { listVocabulary, occurrencesOf } from "../../../src/features/vocabulary/capture.ts";
import {
  announceCard,
  announceSave,
  canSave,
  describeMiss,
  dismissPopover,
  endSave,
  endExplain,
  beginSave,
  DISMISS_REOPEN_SUPPRESS_MS,
  initialPopoverState,
  openPopover,
  requestExplain,
  resolveLookup,
  saveSelection,
  setMeaningDraft,
  summarize,
  type AiAvailability,
  type PopoverState,
  type Selection,
} from "../../../src/ui/vocab/selectionPopover.ts";
import { loadVocabulary, saveMeaning, buildRow } from "../../../src/ui/vocab/vocabularyPage.ts";

const anchor: Anchor = {
  quote: "ubiquitous",
  prefix: "In modern cities, ubiquitous ",
  suffix: " devices are everywhere.",
  locator: { kind: "pdf", pageIndex: 12, pageFraction: 0.42 },
  anchorState: "resolved",
  resolvedAt: 1,
};

const selection: Selection = {
  surface: "ubiquitous",
  sentence: "In modern cities, ubiquitous devices are everywhere.",
  anchor,
  documentId: "doc-1",
  titleSnapshot: "Digital Life",
  rect: { top: 100, left: 200, bottom: 120, right: 320 },
  positionLabel: "Page 13",
};

/** the real `lookup` result shape for the shipped, pack-less state */
const NO_PACK: Lookup = { found: false, reason: "no-active-pack", candidates: [] };

const FOUND: Lookup = {
  found: true,
  result: {
    headword: "ubiquitous",
    normalizedForm: "ubiquitous",
    partOfSpeech: "adj",
    senses: [
      { senseId: 1, gloss: "tersedia di mana-mana", synonyms: [] },
      { senseId: 2, gloss: "ada di setiap tempat", synonyms: ["pervasive"] },
    ],
    matchedVia: "exact",
  },
};

let store: AppDB;

beforeEach(() => {
  store = db;
});

/** drive the popover the way the component does: open, resolve, choose a meaning, save */
async function openedAndSaved(lookupResult: Lookup, meaning: string): Promise<PopoverState> {
  let state = openPopover(initialPopoverState(), selection);
  state = resolveLookup(state, state.requestId, lookupResult);
  state = setMeaningDraft(state, meaning);
  state = beginSave(state);
  return endSave(state, await saveSelection({ store, selection, meaning, provenance: { kind: "dictionary" } }));
}

describe("the core loop: look up a word, then save it", () => {
  it("shows the word and a miss when no pack is installed, then saves the learner's own meaning", async () => {
    let state = openPopover(initialPopoverState(), selection);
    expect(state.open).toBe(true);
    expect(state.status).toBe("looking-up");

    state = resolveLookup(state, state.requestId, NO_PACK);
    expect(state.status).toBe("miss");
    expect(describeMiss(state.lookup!).kind).toBe("no-active-pack");
    // no invented lemma, no invented gloss
    expect(summarize(state.lookup, selection.surface)).toMatchObject({ kind: "none" });

    // the learner types a meaning, which is an explicit action
    expect(canSave(state)).toBe(false);
    state = setMeaningDraft(state, "tersedia di mana-mana");
    expect(canSave(state)).toBe(true);

    state = beginSave(state);
    const outcome = await saveSelection({
      store,
      selection,
      meaning: state.meaningDraft,
      provenance: { kind: "manual" },
    });
    state = endSave(state, outcome);

    expect(outcome.kind).toBe("saved");
    expect(announceSave(outcome)).toBe(`Saved "ubiquitous" to your vocabulary.`);

    const words = await listVocabulary(store);
    expect(words).toHaveLength(1);
    expect(words[0]!.surface).toBe("ubiquitous");
    expect(words[0]!.meaning).toBe("tersedia di mana-mana");
    // the anchor is durable user data; the selection rect is not
    expect(words[0]!.provenance.kind).toBe("manual");
    const occurrences = await occurrencesOf(store, words[0]!.id);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]!.anchor.quote).toBe("ubiquitous");
    expect(occurrences[0]!.anchor.prefix).toBe("In modern cities, ubiquitous ");
    expect(occurrences[0]!.sentence).toBe(selection.sentence);
    expect(JSON.stringify(occurrences[0]!)).not.toContain("rect");
  });

  it("saves the meaning chosen from a dictionary hit, keeping senses separate", async () => {
    let state = openPopover(initialPopoverState(), selection);
    state = resolveLookup(state, state.requestId, FOUND);
    expect(state.status).toBe("ready");
    expect(summarize(state.lookup, selection.surface)).toMatchObject({ kind: "match", senseCount: 2 });

    state = setMeaningDraft(state, "tersedia di mana-mana");
    state = endSave(state, await saveSelection({ store, selection, meaning: state.meaningDraft, provenance: { kind: "dictionary", sourceVersion: "pack-1" } }));
    expect(state.save?.kind).toBe("saved");

    // a different sense of the same word is a separate row, never a merge
    await capture(store, {
      surface: selection.surface,
      anchor,
      titleSnapshot: selection.titleSnapshot,
      sentence: "Another sentence.",
      meaning: "ada di setiap tempat",
      provenance: { kind: "dictionary" },
    });
    const words = await listVocabulary(store);
    expect(words.map((w) => w.meaning).sort()).toEqual(["ada di setiap tempat", "tersedia di mana-mana"]);
  });

  it("attaches a second occurrence instead of duplicating an identical sense", async () => {
    await openedAndSaved(FOUND, "tersedia di mana-mana");
    const second = await saveSelection({ store, selection: { ...selection, sentence: "Seen again here." }, meaning: "tersedia di mana-mana" });
    expect(second.kind).toBe("saved");
    expect(second.kind === "saved" && second.result.kind).toBe("attached");
    expect(await listVocabulary(store)).toHaveLength(1);
    const id = (await listVocabulary(store))[0]!.id;
    expect(await occurrencesOf(store, id)).toHaveLength(2);
  });

  it("refuses to save without a meaning and never reports success for a failed write", async () => {
    const empty = await saveSelection({ store, selection, meaning: "   " });
    expect(empty).toEqual({ kind: "failed", message: "Enter a meaning before saving." });
    expect(announceSave(empty)).toBe("Not saved: Enter a meaning before saving.");
    expect(await listVocabulary(store)).toHaveLength(0);

    // a store whose transaction rejects: the outcome must not read Saved
    const broken = withFailingTransaction("quota exceeded");
    const failed = await saveSelection({ store: broken, selection, meaning: "tersedia di mana-mana" });
    expect(failed).toEqual({ kind: "failed", message: "quota exceeded" });
    expect(announceSave(failed)).toBe("Not saved: quota exceeded");
    expect(announceSave(failed)).not.toContain("Saved");
  });
});

describe("the popover never interrupts reading", () => {
  it("drops a stale lookup result from a superseded selection", async () => {
    let state = openPopover(initialPopoverState(), selection);
    const staleId = state.requestId;
    const next = { ...selection, surface: "leverage" };
    state = openPopover(state, next);

    // the first lookup finally answers, after the learner already selected again
    const late = resolveLookup(state, staleId, FOUND);
    expect(late).toBe(state);
    expect(late.status).toBe("looking-up");
    expect(late.selection?.surface).toBe("leverage");

    state = resolveLookup(state, state.requestId, NO_PACK);
    expect(state.status).toBe("miss");
  });

  it("dismisses to a fully reset card and ignores results that arrive after dismissal", async () => {
    let state = openPopover(initialPopoverState(), selection);
    const requestId = state.requestId;
    state = setMeaningDraft(state, "something");
    state = dismissPopover(state);

    expect(state.open).toBe(false);
    expect(state.selection).toBeNull();
    expect(state.lookup).toBeNull();
    expect(state.meaningDraft).toBe("");
    expect(resolveLookup(state, requestId, FOUND)).toBe(state);
  });

  it("keeps an Escape dismissal final when the reader re-reports the selection on keyup", () => {
    // A reader must open on selection settle to support Shift+Arrow, and Escape
    // produces a keyup that would otherwise reopen the card it just closed.
    let state = openPopover(initialPopoverState(), selection, 1000);
    expect(state.open).toBe(true);
    state = dismissPopover(state, 1000);
    expect(state.open).toBe(false);

    const reopened = openPopover(state, selection, 1100);
    expect(reopened.open).toBe(false);
    expect(reopened.requestId).toBe(state.requestId);

    // a DIFFERENT word is never suppressed
    const other = openPopover(state, { ...selection, surface: "leverage" }, 1100);
    expect(other.open).toBe(true);
    // and a deliberate re-selection later is allowed
    expect(openPopover(state, selection, 1000 + DISMISS_REOPEN_SUPPRESS_MS + 1).open).toBe(true);
  });

  it("announces the card so it is usable without sight of it", () => {
    let state = openPopover(initialPopoverState(), selection);
    state = resolveLookup(state, state.requestId, FOUND);
    expect(announceCard(state, summarize(state.lookup, selection.surface))).toBe(
      "ubiquitous: matched ubiquitous, adj, 2 senses.",
    );

    const missed = openPopover(initialPopoverState(), selection);
    const missState = resolveLookup(missed, missed.requestId, NO_PACK);
    expect(announceCard(missState, summarize(missState.lookup, selection.surface))).toBe(
      "ubiquitous: No dictionary installed yet.",
    );
  });

  it("keeps a close successor's closest candidate but does not call it a match", () => {
    const candidate: Lookup = {
      found: false,
      reason: "not-in-pack",
      candidates: [
        { headword: "ubiquity", normalizedForm: "ubiquity", partOfSpeech: "n", senses: [], matchedVia: "suffix-candidate" },
      ],
    };
    const state = resolveLookup(openPopover(initialPopoverState(), selection), 1, candidate);
    expect(summarize(state.lookup, selection.surface)).toMatchObject({ kind: "candidate", headword: "ubiquity" });
    expect(announceCard(state, summarize(state.lookup, selection.surface))).toBe(
      "ubiquitous: no exact entry. Closest in this pack is ubiquity.",
    );
  });
});

describe("AI is explicit, click-driven, and disabled without a provider", () => {
  const unavailable: AiAvailability = { configured: false, reason: "No AI provider is configured." };

  it("does nothing at all when no provider is configured", async () => {
    let state = openPopover(initialPopoverState(), selection);
    state = resolveLookup(state, state.requestId, NO_PACK);
    const outcome = await requestExplain({ availability: unavailable, selection, signal: new AbortController().signal });
    state = endExplain(state, outcome);
    expect(outcome).toEqual({ kind: "disabled", reason: "No AI provider is configured." });
    expect(state.explainPending).toBe(false);
    expect(state.meaningDraft).toBe("");
  });

  it("calls a configured provider only from requestExplain, and reports failure as failure", async () => {
    let calls = 0;
    const failing: AiAvailability = {
      configured: true,
      provider: {
        id: "test",
        model: "test-model",
        promptVersion: "v1",
        explain: async () => {
          calls += 1;
          throw new Error("quota exceeded");
        },
      },
    };
    const state = openPopover(initialPopoverState(), selection);
    // appearing and looking up made zero calls
    resolveLookup(state, state.requestId, NO_PACK);
    expect(calls).toBe(0);

    const outcome = await requestExplain({ availability: failing, selection, signal: new AbortController().signal });
    expect(outcome).toEqual({ kind: "failed", message: "quota exceeded" });
    expect(calls).toBe(1);
  });
});

describe("vocabulary list shows the original explanation separately from the edited meaning", () => {
  it("keeps both visible after an edit and reports the edit outcome honestly", async () => {
    const created = await capture(store, {
      surface: "ubiquitous",
      anchor,
      titleSnapshot: "Digital Life",
      sentence: selection.sentence,
      meaning: "tersedia di mana-mana",
      provenance: { kind: "ai", sourceVersion: "test/v1" },
      explanation: {
        id: "ex-1",
        requestHash: "hash-1",
        contextText: selection.sentence,
        provider: "test",
        model: "test-model",
        promptVersion: "v1",
        result: { naturalTranslation: "tersedia di mana-mana", provider: "test", model: "test-model", promptVersion: "v1" },
      },
    });

    const before = await loadVocabulary(store);
    expect(before.rows[0]!.originalExplanation).toContain("tersedia di mana-mana");
    expect(before.rows[0]!.meaningEdited).toBe(false);

    const saved = await saveMeaning(store, created.vocabulary.id, "ada di mana-mana, termasuk hal yang biasa");
    expect(saved.kind).toBe("saved");

    const after = await loadVocabulary(store);
    expect(after.rows[0]!.vocabulary.meaning).toBe("ada di mana-mana, termasuk hal yang biasa");
    // the generated text is intact and still distinct
    expect(after.rows[0]!.originalExplanation).toBe("tersedia di mana-mana");
    expect(after.rows[0]!.meaningEdited).toBe(true);
    expect(after.rows[0]!.vocabulary.explanationEditedAt).toBeTypeOf("number");

    const failed = await saveMeaning(store, created.vocabulary.id, "  ");
    expect(failed.kind).toBe("failed");
  });

  it("marks a source unavailable without hiding the word", () => {
    const row = buildRow(
      {
        id: "v1",
        surface: "ubiquitous",
        normalizedForm: "ubiquitous",
        meaning: "tersedia di mana-mana",
        status: "learning",
        provenance: { kind: "manual", createdAt: 1, userEdited: false },
        createdAt: 1,
        updatedAt: 1,
      },
      [{ id: "o1", vocabularyId: "v1", documentId: "gone", titleSnapshot: "Deleted Book", anchor, sentence: "x" }],
      new Set<string>(),
    );
    expect(row.sourcesUnavailable).toBe(true);
    expect(row.sourceTitles).toEqual(["Deleted Book"]);
  });

  it("filters by query and status", async () => {
    for (const surface of ["ubiquitous", "leverage", "salient"]) {
      await capture(store, { surface, anchor, titleSnapshot: "B", sentence: "s", meaning: `${surface} meaning` });
    }
    const page = await loadVocabulary(store, { query: "lev", status: "all" });
    expect(page.filtered).toBe(1);
    expect(page.rows[0]!.vocabulary.surface).toBe("leverage");
  });
});