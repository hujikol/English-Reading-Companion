/**
 * Vocabulary list model.
 *
 * The list shows four things per word that must stay visibly distinct:
 * the surface form, the user's current meaning, the ORIGINAL generated
 * explanation, and the occurrences it was seen in (section 11). Editing a
 * meaning never touches `explanationText`; that separation is the point.
 */

import type { Occurrence, Vocabulary } from "../../contracts/index.ts";
import { editMeaning, listVocabulary, occurrencesOf, setNote } from "../../features/vocabulary/capture.ts";
import type { Store } from "../../features/vocabulary/store.ts";

export type VocabularyRow = {
  vocabulary: Vocabulary;
  occurrences: Occurrence[];
  /** true once the meaning differs from the generated explanation */
  meaningEdited: boolean;
  /** the original AI text, kept distinct from the meaning */
  originalExplanation: string | null;
  /** where the user saw it; a missing document is "unavailable", not an error */
  sourceTitles: string[];
  sourcesUnavailable: boolean;
};

export type VocabularyFilter = { query: string; status: "all" | "learning" | "known" };

export const matchesFilter = (row: VocabularyRow, filter: VocabularyFilter): boolean => {
  if (filter.status !== "all" && row.vocabulary.status !== filter.status) return false;
  const q = filter.query.trim().toLowerCase();
  if (q === "") return true;
  return (
    row.vocabulary.surface.toLowerCase().includes(q) ||
    row.vocabulary.meaning.toLowerCase().includes(q) ||
    (row.vocabulary.lemma ?? "").toLowerCase().includes(q)
  );
};

export const buildRow = (vocabulary: Vocabulary, occurrences: Occurrence[], availableTitles: ReadonlySet<string>): VocabularyRow => ({
  vocabulary,
  occurrences: [...occurrences].sort((a, b) => a.titleSnapshot.localeCompare(b.titleSnapshot)),
  meaningEdited:
    vocabulary.explanationText !== undefined &&
    vocabulary.explanationEditedAt !== undefined &&
    vocabulary.meaning.trim() !== vocabulary.explanationText.trim(),
  originalExplanation: vocabulary.explanationText ?? null,
  sourceTitles: [...new Set(occurrences.map((o) => o.titleSnapshot).filter(Boolean))],
  sourcesUnavailable: occurrences.some((o) => o.documentId !== undefined && !availableTitles.has(o.documentId)),
});

export type VocabularyPage = {
  rows: VocabularyRow[];
  total: number;
  filtered: number;
  query: string;
  status: VocabularyFilter["status"];
};

export async function loadVocabulary(
  store: Store,
  filter: VocabularyFilter = { query: "", status: "all" },
  availableTitles: ReadonlySet<string> = new Set(),
): Promise<VocabularyPage> {
  const all = await listVocabulary(store);
  const rows: VocabularyRow[] = [];
  for (const vocabulary of all) rows.push(buildRow(vocabulary, await occurrencesOf(store, vocabulary.id), availableTitles));
  const filtered = rows.filter((r) => matchesFilter(r, filter));
  return { rows: filtered, total: rows.length, filtered: filtered.length, query: filter.query, status: filter.status };
}

/** "edited" is a comparison, not a stored flag: the meaning IS the current answer. */
export const isEdited = (row: VocabularyRow): boolean => row.meaningEdited;

export type EditOutcome = { kind: "saved"; vocabulary: Vocabulary } | { kind: "failed"; message: string };

/** Rejection keeps the row on screen and unsaved; it never reads Saved (section 4). */
export async function saveMeaning(store: Store, vocabularyId: string, meaning: string): Promise<EditOutcome> {
  const trimmed = meaning.trim();
  if (trimmed === "") return { kind: "failed", message: "A meaning cannot be empty." };
  try {
    return { kind: "saved", vocabulary: await editMeaning(store, vocabularyId, trimmed) };
  } catch (e) {
    return { kind: "failed", message: e instanceof Error ? e.message : "The meaning could not be saved." };
  }
}

export async function saveNote(store: Store, vocabularyId: string, note: string): Promise<EditOutcome> {
  try {
    return { kind: "saved", vocabulary: await setNote(store, vocabularyId, note) };
  } catch (e) {
    return { kind: "failed", message: e instanceof Error ? e.message : "The note could not be saved." };
  }
}

export const announceEdit = (surface: string, o: EditOutcome): string =>
  o.kind === "saved" ? `Updated the meaning of "${surface}".` : `Not updated: ${o.message}`;