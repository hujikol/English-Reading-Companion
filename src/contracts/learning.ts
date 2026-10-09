/**
 * Learning-data contract. Owned by Track F, extended by Track G.
 */

import type { Anchor } from "./document.ts";

export type Provenance = {
  kind: "dictionary" | "ai" | "manual";
  /** pack version, or provider/model/prompt version */
  sourceVersion?: string;
  createdAt: number;
  userEdited: boolean;
};

/** Named "Mark" because `Highlight` is a DOM global (CSS Custom Highlight API). */
export type Mark = {
  id: string;
  documentId: string;
  titleSnapshot: string;
  anchor: Anchor;
  color: "yellow" | "green" | "blue" | "pink";
  createdAt: number;
  deletedAt?: number;
};

export type Vocabulary = {
  id: string;
  surface: string;
  normalizedForm: string;
  lemma?: string;
  /** the user's current meaning, editable */
  meaning: string;
  /** the original generated explanation, never overwritten by user edits */
  explanationText?: string;
  explanationEditedAt?: number;
  note?: string;
  status: "learning" | "known" | "suspended";
  provenance: Provenance;
  createdAt: number;
  updatedAt: number;
};

export type Occurrence = {
  id: string;
  vocabularyId: string;
  documentId?: string;
  titleSnapshot: string;
  anchor: Anchor;
  sentence: string;
};

export type LearningExplanation = {
  naturalTranslation: string;
  sentenceExplanation?: string;
  contextualMeaning?: string;
  alternateMeanings?: { meaning: string; usage: string; example: { english: string; indonesian: string } }[];
  partOfSpeech?: string;
  grammarNote?: string;
  simplerEnglish?: string;
  example?: { english: string; indonesian: string };
  provider: string;
  model: string;
  promptVersion: string;
};

/**
 * Durable, append-only AI record. Distinct from aiCache, which is a TTL/LRU
 * network-cost optimization and may evict. A cache hit still writes this row.
 */
export type Explanation = {
  id: string;
  requestHash: string;
  documentId?: string;
  surface: string;
  /** exactly what was submitted, so a stored result can be judged against it */
  contextText: string;
  result: LearningExplanation;
  provider: string;
  model: string;
  promptVersion: string;
  createdAt: number;
  deletedAt?: number;
};

export type ReviewGrade = "again" | "got-it" | "known";
