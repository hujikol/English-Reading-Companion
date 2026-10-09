import type { Anchor, Explanation, LearningExplanation, Occurrence, Provenance, Vocabulary } from "../../contracts/index.ts";
import type { AppDB } from "../../db/index.ts";

/** Same term + same chosen meaning is the same sense; anything else is a new one. */
export type CaptureResult =
  | { kind: "created"; vocabulary: Vocabulary; occurrence: Occurrence }
  | { kind: "attached"; vocabulary: Vocabulary; occurrence: Occurrence };

export type CaptureInput = {
  surface: string;
  anchor: Anchor;
  titleSnapshot: string;
  sentence: string;
  documentId?: string;
  meaning: string;
  lemma?: string;
  note?: string;
  /** absent for a manual save with no dictionary match */
  provenance?: { kind: Provenance["kind"]; sourceVersion?: string; userEdited?: boolean };
  /** durable explanation snapshot supplied by Track G, copied into explanationText */
  explanation?: Omit<Explanation, "surface" | "createdAt">;
};

const newId = (): string => crypto.randomUUID();

/**
 * Index key and sense comparison key. NFKC + casefold so "Leverage," and
 * "leverage" are one term; diacritics are kept because English learners meet
 * them in real text.
 */
export const normalizeForm = (surface: string): string =>
  surface.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");

const senseKey = (meaning: string): string => meaning.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/** Single readable copy of a validated AI result; the structured row is the source of truth. */
export function explanationTextOf(result: LearningExplanation): string {
  const parts: string[] = [result.naturalTranslation];
  if (result.sentenceExplanation) parts.push(`Sentence meaning: ${result.sentenceExplanation}`);
  if (result.partOfSpeech) parts.push(`(${result.partOfSpeech})`);
  if (result.contextualMeaning) parts.push(result.contextualMeaning);
  for (const alternative of result.alternateMeanings ?? []) {
    parts.push(`Other meaning: ${alternative.meaning}`, `Usage: ${alternative.usage}`, `e.g. ${alternative.example.english} — ${alternative.example.indonesian}`);
  }
  if (result.grammarNote) parts.push(`Grammar: ${result.grammarNote}`);
  if (result.simplerEnglish) parts.push(`Simpler: ${result.simplerEnglish}`);
  if (result.example) parts.push(`e.g. ${result.example.english} — ${result.example.indonesian}`);
  return parts.join("\n");
}

/**
 * Explicit save. Never called implicitly by highlighting or by quota recovery.
 *
 * An identical chosen meaning attaches a new Occurrence instead of merging or
 * duplicating the word; a different meaning creates a separate Vocabulary row so
 * senses stay distinct. `explanationText` is written once, here.
 */
export async function capture(
  store: AppDB,
  input: CaptureInput,
  opts: { now?: number; forceSeparate?: boolean } = {},
): Promise<CaptureResult> {
  const now = opts.now ?? Date.now();
  const surface = input.surface.trim();
  if (!surface) throw new Error("capture: surface is required");
  const meaning = input.meaning.trim();
  if (!meaning) throw new Error("capture: meaning is required");

  const normalizedForm = normalizeForm(surface);
  const provenance: Provenance = {
    kind: input.provenance?.kind ?? "manual",
    userEdited: input.provenance?.userEdited ?? false,
    createdAt: now,
    ...(input.provenance?.sourceVersion === undefined ? {} : { sourceVersion: input.provenance.sourceVersion }),
  };
  const explanationCopy = input.explanation
    ? explanationTextOf(input.explanation.result)
    : undefined;

  const existing = (await store.vocabulary.filter((v) => (v as Vocabulary).normalizedForm === normalizedForm).toArray()) as Vocabulary[];
  const same = opts.forceSeparate
    ? undefined
    : existing.find((v) => senseKey(v.meaning) === senseKey(meaning));

  const vocabularyId = same?.id ?? newId();
  const occurrence: Occurrence = {
    id: newId(),
    vocabularyId,
    titleSnapshot: input.titleSnapshot,
    anchor: input.anchor,
    sentence: input.sentence,
    ...(input.documentId === undefined ? {} : { documentId: input.documentId }),
  };

  const row: Vocabulary = same ?? {
    id: vocabularyId,
    surface,
    normalizedForm,
    meaning,
    status: "learning",
    provenance,
    createdAt: now,
    updatedAt: now,
    ...(input.lemma === undefined ? {} : { lemma: input.lemma }),
    ...(input.note === undefined ? {} : { note: input.note }),
    ...(explanationCopy === undefined ? {} : { explanationText: explanationCopy }),
  };

  const card = { vocabularyId, stage: 0, dueAt: now, suspended: false };

  await store.transaction("rw", [store.vocabulary, store.occurrences, store.explanations, store.reviewCards], async () => {
    if (same) {
      // the word row is untouched: its meaning, notes and original explanation stay as the user left them
      if (input.explanation) await store.explanations.put({ ...input.explanation, surface, createdAt: now });
    } else {
      await store.vocabulary.put(row);
      await store.explanations.bulkPut(
        input.explanation ? [{ ...input.explanation, surface, createdAt: now }] : [],
      );
      await store.reviewCards.put(card);
    }
    await store.occurrences.put(occurrence);
  });

  return { kind: same ? "attached" : "created", vocabulary: row, occurrence };
}

/**
 * Edit the user's current meaning. `explanationText` is never written here, so
 * the original generated explanation survives any number of edits.
 */
export async function editMeaning(store: AppDB, vocabularyId: string, meaning: string, opts: { now?: number } = {}): Promise<Vocabulary> {
  const now = opts.now ?? Date.now();
  const current = (await store.vocabulary.get(vocabularyId)) as Vocabulary | undefined;
  if (!current) throw new Error(`editMeaning: unknown vocabulary ${vocabularyId}`);
  const next: Vocabulary = {
    ...current,
    meaning,
    updatedAt: now,
    provenance: { ...current.provenance, userEdited: true },
    // divergence is recorded once, at the first edit away from the generated text
    ...(current.explanationText !== undefined && current.explanationText !== meaning && current.explanationEditedAt === undefined
      ? { explanationEditedAt: now }
      : {}),
  };
  await store.vocabulary.put(next);
  return next;
}

export async function setNote(store: AppDB, vocabularyId: string, note: string, opts: { now?: number } = {}): Promise<Vocabulary> {
  const now = opts.now ?? Date.now();
  const current = (await store.vocabulary.get(vocabularyId)) as Vocabulary | undefined;
  if (!current) throw new Error(`setNote: unknown vocabulary ${vocabularyId}`);
  const next: Vocabulary = { ...current, note, updatedAt: now };
  await store.vocabulary.put(next);
  return next;
}

/** The same sense already saved, so a UI can offer "attach another example". */
export async function findSameSense(store: AppDB, surface: string, meaning: string): Promise<Vocabulary | undefined> {
  const normalizedForm = normalizeForm(surface);
  const rows = (await store.vocabulary.filter((v) => (v as Vocabulary).normalizedForm === normalizedForm).toArray()) as Vocabulary[];
  return rows.find((v) => senseKey(v.meaning) === senseKey(meaning));
}

export async function listVocabulary(store: AppDB, includeDeleted = false): Promise<Vocabulary[]> {
  const rows = (await store.vocabulary.toArray()) as Vocabulary[];
  return rows.filter((v) => includeDeleted || v.status !== "suspended").sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Explicit user removal only. The durable explanation history is never deleted
 * with the word, and no caller of this function exists on a quota path.
 */
export async function deleteVocabulary(store: AppDB, vocabularyId: string): Promise<void> {
  const occurrences = (await store.occurrences.filter((o) => (o as Occurrence).vocabularyId === vocabularyId).toArray()) as Occurrence[];
  await store.transaction("rw", [store.vocabulary, store.occurrences, store.reviewCards], async () => {
    await store.occurrences.bulkDelete(occurrences.map((o) => o.id));
    await store.vocabulary.delete(vocabularyId);
    await store.reviewCards.delete(vocabularyId);
  });
}

export async function occurrencesOf(store: AppDB, vocabularyId: string): Promise<Occurrence[]> {
  // No ordering is promised: `Occurrence` records no timestamp, and the random
  // id gives no useful sort key. Callers that need "first seen" must add a
  // createdAt to the record rather than rely on table order.
  return (await store.occurrences.filter((o) => (o as Occurrence).vocabularyId === vocabularyId).toArray()) as Occurrence[];
}
