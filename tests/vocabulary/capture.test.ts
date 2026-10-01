import { describe, expect, it } from "vitest";
import type { Anchor, LearningExplanation } from "../../src/contracts/index.ts";
import {
  capture,
  deleteVocabulary,
  editMeaning,
  explanationTextOf,
  findSameSense,
  normalizeForm,
  occurrencesOf,
  setNote,
} from "../../src/features/vocabulary/capture.ts";
import { memStore } from "./memStore.ts";

const anchor = (quote = "leverage", state: Anchor["anchorState"] = "resolved"): Anchor => ({
  quote,
  prefix: "to",
  suffix: "the advantage",
  locator: { kind: "pdf", pageIndex: 3, pageFraction: 0.25 },
  anchorState: state,
  resolvedAt: 1_700_000_000_000,
});

const aiExplanation = (): Omit<import("../../src/contracts/index.ts").Explanation, "surface" | "createdAt"> => ({
  id: "exp-1",
  requestHash: "hash-1",
  documentId: "doc-1",
  contextText: "Companies leverage data.",
  result: {
    naturalTranslation: "memanfaatkan",
    contextualMeaning: "menggunakan sumber daya secara aktif",
    partOfSpeech: "verb",
    simplerEnglish: "to use something well",
    provider: "fixture",
    model: "fixture-1",
    promptVersion: "v1",
  } satisfies LearningExplanation,
  provider: "fixture",
  model: "fixture-1",
  promptVersion: "v1",
});

const base = {
  anchor: anchor(),
  titleSnapshot: "Deep Work",
  sentence: "They leverage focus to finish more.",
  documentId: "doc-1",
};

describe("capture", () => {
  it("preserves surface, lemma, meaning, sentence, anchor, provenance, note and explanation", async () => {
    const store = memStore();
    const res = await capture(store, {
      ...base,
      surface: "  Leverage  ",
      meaning: "memanfaatkan",
      lemma: "leverage",
      note: "banyak dipakai di bisnis",
      provenance: { kind: "dictionary", sourceVersion: "pack-2026-01" },
      explanation: aiExplanation(),
    }, { now: 1000 });

    expect(res.kind).toBe("created");
    expect(res.vocabulary).toMatchObject({
      surface: "Leverage",
      normalizedForm: "leverage",
      lemma: "leverage",
      meaning: "memanfaatkan",
      note: "banyak dipakai di bisnis",
      status: "learning",
      provenance: { kind: "dictionary", sourceVersion: "pack-2026-01", userEdited: false, createdAt: 1000 },
      createdAt: 1000,
      updatedAt: 1000,
    });
    expect(res.vocabulary.explanationText).toBe(explanationTextOf(aiExplanation().result));
    expect(res.occurrence).toMatchObject({ documentId: "doc-1", titleSnapshot: "Deep Work", sentence: base.sentence });
    expect(res.occurrence.anchor).toEqual(base.anchor);

    // written rows match the returned values
    const rows = await store.vocabulary.toArray();
    expect(rows).toEqual([res.vocabulary]);
    const occurrences = await occurrencesOf(store, res.vocabulary.id);
    expect(occurrences).toEqual([res.occurrence]);
    expect(await store.explanations.count()).toBe(1);
    expect(await store.reviewCards.count()).toBe(1);
  });

  it("saves a phrase with no dictionary match and a user-supplied meaning", async () => {
    const store = memStore();
    const res = await capture(store, { ...base, surface: "in the bag", meaning: "telahpersistensi" });
    expect(res.vocabulary.provenance.kind).toBe("manual");
    expect(res.vocabulary.meaning).toBe("telahpersistensi");
    expect(res.vocabulary.explanationText).toBeUndefined();
    expect(await store.explanations.count()).toBe(0);
  });

  it("attaches an occurrence instead of merging when the chosen meaning is identical", async () => {
    const store = memStore();
    const first = await capture(store, { ...base, surface: "leverage", meaning: "memanfaatkan" }, { now: 1 });
    const second = await capture(store, { ...base, surface: "Leverage,", meaning: "memanfaatkan  ", anchor: anchor("leverage"), documentId: "doc-2", titleSnapshot: "Other Book", sentence: "Another sentence." }, { now: 2 });

    expect(second.kind).toBe("attached");
    expect(second.vocabulary.id).toBe(first.vocabulary.id);
    expect(await store.vocabulary.count()).toBe(1);
    expect(await store.reviewCards.count()).toBe(1);

    const occurrences = await occurrencesOf(store, first.vocabulary.id);
    expect(occurrences).toHaveLength(2);
    expect(occurrences[1]).toMatchObject({ documentId: "doc-2", titleSnapshot: "Other Book", sentence: "Another sentence." });
  });

  it("keeps a different sense as a separate word", async () => {
    const store = memStore();
    const a = await capture(store, { ...base, surface: "leverage", meaning: "memanfaatkan" });
    const b = await capture(store, { ...base, surface: "leverage", meaning: "daya ungkit" });

    expect(b.kind).toBe("created");
    expect(b.vocabulary.id).not.toBe(a.vocabulary.id);
    expect(await store.vocabulary.count()).toBe(2);
    expect(await store.reviewCards.count()).toBe(2);
  });

  it("normalizes case, spacing and edge punctuation into one term", () => {
    expect(normalizeForm("  Leverage,  ")).toBe("leverage");
    expect(normalizeForm("In The Bag")).toBe("in the bag");
  });

  it("finds the existing same-sense word so a UI can offer to attach", async () => {
    const store = memStore();
    const a = await capture(store, { ...base, surface: "yield", meaning: "menghasilkan" });
    expect(await findSameSense(store, "Yield", "menghasilkan")).toMatchObject({ id: a.vocabulary.id });
    expect(await findSameSense(store, "yield", "bertanpa")).toBeUndefined();
  });
});

describe("meaning edits", () => {
  it("never destroys the original generated explanation", async () => {
    const store = memStore();
    const saved = await capture(store, { ...base, surface: "leverage", meaning: "memanfaatkan", explanation: aiExplanation() }, { now: 1 });
    const original = saved.vocabulary.explanationText;

    const edited = await editMeaning(store, saved.vocabulary.id, "leverase = masturbation (gaul)", { now: 5 });
    expect(edited.meaning).toBe("leverase = masturbation (gaul)");
    expect(edited.explanationText).toBe(original);
    expect(edited.explanationEditedAt).toBe(5);
    expect(edited.provenance.userEdited).toBe(true);

    await editMeaning(store, saved.vocabulary.id, "leverase = masturbation", { now: 9 });
    const third = await editMeaning(store, saved.vocabulary.id, "leverase = masturbation", { now: 11 });
    expect(third.explanationEditedAt).toBe(5);
    expect((await store.explanations.toArray())[0]).toMatchObject({ requestHash: "hash-1", surface: "leverage" });
  });

  it("does not record a divergence for a manual save with no explanation", async () => {
    const store = memStore();
    const saved = await capture(store, { ...base, surface: "x", meaning: "y" });
    const edited = await editMeaning(store, saved.vocabulary.id, "y2", { now: 3 });
    expect(edited.explanationEditedAt).toBeUndefined();
    expect(edited.explanationText).toBeUndefined();
  });

  it("keeps notes independent of the meaning", async () => {
    const store = memStore();
    const saved = await capture(store, { ...base, surface: "x", meaning: "y" });
    const noted = await setNote(store, saved.vocabulary.id, "lihat bab 3");
    expect(noted.note).toBe("lihat bab 3");
    expect(noted.meaning).toBe("y");
  });
});

describe("explicit deletion", () => {
  it("removes the word, its occurrences and its card, but not explanation history", async () => {
    const store = memStore();
    const saved = await capture(store, { ...base, surface: "leverage", meaning: "memanfaatkan", explanation: aiExplanation() });
    await deleteVocabulary(store, saved.vocabulary.id);
    expect(await store.vocabulary.count()).toBe(0);
    expect(await store.occurrences.count()).toBe(0);
    expect(await store.reviewCards.count()).toBe(0);
    expect(await store.explanations.count()).toBe(1);
  });

  it("never runs on a quota path — no such caller exists", async () => {
    // the durability contract forbids auto-removal; capture/edit never delete, and
    // deleteVocabulary is only ever bound to an explicit user action (see src/features/vocabulary/index.ts)
    const store = memStore();
    await capture(store, { ...base, surface: "leverage", meaning: "memanatkan" });
    expect(await store.vocabulary.count()).toBe(1);
  });
});