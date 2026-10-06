/**
 * Review session model.
 *
 * Section 11, v0.1: show the English word and optional original sentence, reveal
 * the saved meaning, let the learner mark Learning or Known, record the event.
 * The queue itself is Track F's `buildQueue`/`applyGrade`; this module only adds
 * the UI state around it — reveal, session progress, and honest write outcomes.
 */

import type { AppDB } from "../../../src/db/index.ts";
import type { ReviewGrade } from "../../contracts/index.ts";
import {
  applyGrade,
  buildQueue,
  getDailySessionSize,
  gradeKeepsCardQueued,
  setDailySessionSize,
  type Queue,
  type QueueItem,
} from "../../features/review/queue.ts";

export type ReviewSession = {
  queue: Queue;
  /** index into queue.items; equals items.length when the session is done */
  index: number;
  revealed: boolean;
  /** ids graded in this session, for the progress readout */
  done: number;
  /** ids that came back because they were marked Learning */
  repeats: number;
  pending: boolean;
  error: string | null;
  lastOutcome: GradeOutcome | null;
  sessionSize: number;
};

export type GradeOutcome =
  | { kind: "recorded"; grade: ReviewGrade; vocabularyId: string; returnedToQueue: boolean; duplicate: boolean }
  | { kind: "failed"; grade: ReviewGrade; vocabularyId: string; message: string };

export async function startSession(store: AppDB, sessionSize?: number): Promise<ReviewSession> {
  const size = sessionSize ?? (await getDailySessionSize(store));
  const queue = await buildQueue(store, size);
  return { queue, index: 0, revealed: false, done: 0, repeats: 0, pending: false, error: null, lastOutcome: null, sessionSize: size };
}

export const currentItem = (s: ReviewSession): QueueItem | undefined => s.queue.items[s.index];
export const isSessionComplete = (s: ReviewSession): boolean => s.index >= s.queue.items.length;

export const reveal = (s: ReviewSession): ReviewSession => ({ ...s, revealed: true });

export type SessionSizeOutcome = { kind: "saved"; size: number } | { kind: "failed"; message: string };

/** `setDailySessionSize` throws RangeError outside 1..200; the UI must show that, not a crash. */
export async function changeSessionSize(store: AppDB, raw: number): Promise<SessionSizeOutcome> {
  const size = Math.trunc(raw);
  if (!Number.isFinite(size) || size < 1 || size > 200) return { kind: "failed", message: "Choose between 1 and 200 words per session." };
  try {
    await setDailySessionSize(store, size);
    return { kind: "saved", size };
  } catch (e) {
    return { kind: "failed", message: e instanceof Error ? e.message : "The session size could not be saved." };
  }
}

/**
 * Reveal is required first: a grade without a reveal is a blind tap, and the
 * event would still be written. This returns the session untouched.
 */
export function canGrade(s: ReviewSession): boolean {
  const item = currentItem(s);
  return item !== undefined && s.revealed && !s.pending && !isSessionComplete(s);
}

/**
 * Grade the visible card.
 *
 * `eventId` is generated per card per session here, so a double tap replays the
 * same key and `applyGrade` drops it. A Learning grade puts the card back at the
 * END of the remaining session rather than removing it — the learner chose to
 * keep practising it. Known suspends it and it leaves the session.
 */
export async function gradeCurrent(
  store: AppDB,
  session: ReviewSession,
  grade: ReviewGrade,
  now: number = Date.now(),
): Promise<{ session: ReviewSession; outcome: GradeOutcome }> {
  const item = currentItem(session);
  if (item === undefined || !session.revealed)
    return {
      session: { ...session, error: "Reveal the meaning before grading." },
      outcome: { kind: "failed", grade, vocabularyId: item?.vocabulary.id ?? "", message: "Reveal the meaning before grading." },
    };

  const vocabularyId = item.vocabulary.id;
  const eventId = `${session.queue.items.length}:${vocabularyId}:${grade}:${session.index}`;
  const pending: ReviewSession = { ...session, pending: true, error: null };

  try {
    const { card, duplicate } = await applyGrade(store, vocabularyId, grade, eventId, now);
    const returnedToQueue = gradeKeepsCardQueued(grade) && !card.suspended && !duplicate;
    // Learning keeps the card in play: it returns at the END of this session,
    // including when it was the last card. The guard is `!card.suspended`, not a
    // position check — a position check drops the repeat in a 1-card session,
    // which is the one case where the learner most wants it back.
    const items = returnedToQueue ? [...session.queue.items, item] : session.queue.items;
    const next: ReviewSession = {
      ...pending,
      queue: { ...session.queue, items },
      index: session.index + 1,
      revealed: false,
      done: session.done + (duplicate ? 0 : 1),
      repeats: session.repeats + (returnedToQueue ? 1 : 0),
      lastOutcome: { kind: "recorded", grade, vocabularyId, returnedToQueue, duplicate },
    };
    return { session: next, outcome: next.lastOutcome as GradeOutcome };
  } catch (e) {
    // the write failed: keep the card, the reveal and the focus. Never advance.
    const message = e instanceof Error ? e.message : "The review could not be recorded.";
    const failed: ReviewSession = { ...session, pending: false, error: message };
    return { session: failed, outcome: { kind: "failed", grade, vocabularyId, message } };
  }
}

export const gradeLabel = (grade: ReviewGrade): string =>
  grade === "again" ? "Learning" : grade === "got-it" ? "Got it" : "Known";

export const announceGrade = (o: GradeOutcome): string =>
  o.kind === "recorded"
    ? o.duplicate
      ? `Already recorded as ${gradeLabel(o.grade)}.`
      : `Recorded as ${gradeLabel(o.grade)}.`
    : `Not recorded: ${o.message}`;

export const announceSessionSize = (o: SessionSizeOutcome): string =>
  o.kind === "saved" ? `Session size set to ${o.size} words.` : `Session size unchanged: ${o.message}`;