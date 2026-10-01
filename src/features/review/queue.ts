import type { ReviewGrade, Vocabulary } from "../../contracts/index.ts";
import type { ReviewCard, ReviewEvent } from "../../db/index.ts";
import type { Store } from "../vocabulary/store.ts";

/** v0.1 queue shape only. No ladder, no SRS — Section 11 "Basic review in v0.1". */
export const DAILY_SESSION_DEFAULT = 20;
export const SETTING_DAILY_SESSION_SIZE = "review.dailySessionSize";

export type QueueItem = {
  vocabulary: Vocabulary;
  card: ReviewCard;
  /** most recent occurrence's original sentence, if any */
  sentence?: string;
};

export type Queue = {
  items: QueueItem[];
  /** cards omitted because the learner's session size was reached */
  overflow: number;
  sessionSize: number;
};

const learningGrades: ReadonlySet<ReviewGrade> = new Set<ReviewGrade>(["again", "got-it"]);

/** Learning keeps the card in the queue; Known is the explicit suspension choice. */
export const gradeKeepsCardQueued = (grade: ReviewGrade): boolean => learningGrades.has(grade);

export async function getDailySessionSize(store: Store, fallback = DAILY_SESSION_DEFAULT): Promise<number> {
  const row = (await store.settings.get(SETTING_DAILY_SESSION_SIZE)) as { key: string; value: unknown } | undefined;
  const n = typeof row?.value === "number" ? Math.trunc(row.value) : fallback;
  return n >= 1 && n <= 200 ? n : fallback;
}

export async function setDailySessionSize(store: Store, size: number): Promise<void> {
  if (!Number.isInteger(size) || size < 1 || size > 200) throw new RangeError("daily session size must be 1..200");
  await store.settings.put({ key: SETTING_DAILY_SESSION_SIZE, value: size, schemaVersion: 1 });
}

/**
 * Least recently reviewed first. A card never reviewed sorts as oldest; new
 * cards therefore come first, which is what a learner opening a fresh session
 * expects. Suspended (Known) cards are excluded, not reordered.
 */
export async function buildQueue(store: Store, sessionSize?: number, now = Date.now()): Promise<Queue> {
  const size = sessionSize ?? (await getDailySessionSize(store));
  const cards = (await store.reviewCards.toArray()) as ReviewCard[];
  const words = (await store.vocabulary.toArray()) as Vocabulary[];
  const occurrences = await store.occurrences.toArray();
  const byVocabulary = new Map(words.map((v) => [v.id, v]));
  const sentences = new Map<string, string>();
  for (const o of occurrences as { vocabularyId: string; sentence: string }[]) {
    if (o.sentence && !sentences.has(o.vocabularyId)) sentences.set(o.vocabularyId, o.sentence);
  }

  const ranked = cards
    .filter((c) => !c.suspended && byVocabulary.has(c.vocabularyId))
    .sort((a, b) => (a.lastReviewedAt ?? 0) - (b.lastReviewedAt ?? 0) || a.vocabularyId.localeCompare(b.vocabularyId));
  void now;

  const items: QueueItem[] = ranked.slice(0, size).map((card) => {
    const vocabulary = byVocabulary.get(card.vocabularyId);
    if (!vocabulary) throw new Error(`review card ${card.vocabularyId} has no vocabulary row`);
    const sentence = sentences.get(card.vocabularyId);
    return sentence === undefined ? { vocabulary, card } : { vocabulary, card, sentence };
  });

  return { items, overflow: ranked.length - items.length, sessionSize: size };
}

/**
 * Apply one review action.
 *
 * `eventId` is the session-generated id for this tap, so a double tap replays
 * the same key and is dropped by the primary key instead of writing a second
 * event. Card state and its event are written in one transaction.
 */
export async function applyGrade(
  store: Store,
  vocabularyId: string,
  grade: ReviewGrade,
  eventId: string,
  now = Date.now(),
): Promise<{ event: ReviewEvent; card: ReviewCard; duplicate: boolean }> {
  const existing = (await store.reviewEvents.get(eventId)) as ReviewEvent | undefined;
  const current = (await store.reviewCards.get(vocabularyId)) as ReviewCard | undefined;
  if (!current) throw new Error(`applyGrade: no review card for ${vocabularyId}`);

  if (existing) {
    // second tap on the same action: return the original write, write nothing
    const card = (await store.reviewCards.get(vocabularyId)) as ReviewCard;
    return { event: existing, card, duplicate: true };
  }

  const known = grade === "known";
  const card: ReviewCard = {
    vocabularyId,
    stage: current.stage,
    dueAt: now,
    lastReviewedAt: now,
    suspended: known,
  };
  const event: ReviewEvent = {
    id: eventId,
    cardId: vocabularyId,
    grade,
    stageBefore: current.stage,
    stageAfter: current.stage,
    reviewedAt: now,
  };

  const vocab = (await store.vocabulary.get(vocabularyId)) as Vocabulary | undefined;
  const nextVocab: Vocabulary | undefined =
    vocab === undefined
      ? undefined
      : { ...vocab, status: known ? "known" : "learning", updatedAt: now };

  await store.transaction("rw", [store.reviewEvents, store.reviewCards, store.vocabulary], async () => {
    await store.reviewEvents.put(event);
    await store.reviewCards.put(card);
    if (nextVocab) await store.vocabulary.put(nextVocab);
  });

  return { event, card, duplicate: false };
}

/**
 * Recompute card state purely from its events. Events are the durable record;
 * cards are a derived index, so a restore or a crash mid-write is repairable.
 */
export async function stateFromEvents(events: readonly ReviewEvent[], vocabularyId: string): Promise<ReviewCard | undefined> {
  const mine = events
    .filter((e) => e.cardId === vocabularyId)
    .sort((a, b) => a.reviewedAt - b.reviewedAt || a.id.localeCompare(b.id));
  const last = mine.at(-1);
  const first = mine[0];
  if (!last || !first) return undefined;
  return {
    vocabularyId,
    stage: last.stageAfter,
    dueAt: last.reviewedAt,
    lastReviewedAt: last.reviewedAt,
    suspended: last.grade === "known",
  };
}

export async function eventsFor(store: Store, vocabularyId: string): Promise<ReviewEvent[]> {
  return ((await store.reviewEvents.filter((e) => (e as ReviewEvent).cardId === vocabularyId).toArray()) as ReviewEvent[])
    .sort((a, b) => a.reviewedAt - b.reviewedAt);
}