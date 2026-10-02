/**
 * Review screen model over the real `buildQueue`/`applyGrade`.
 *
 * The rules under test: reveal before grade, Learning returns the card to the
 * session, Known suspends it, a failed write keeps the card on screen, and a
 * double tap records one event.
 */

import { beforeEach, describe, expect, it } from "vitest";

import type { Anchor } from "../../../src/contracts/index.ts";
import { capture } from "../../../src/features/vocabulary/capture.ts";
import type { ReviewEvent } from "../../../src/db/index.ts";
import { DAILY_SESSION_DEFAULT, SETTING_DAILY_SESSION_SIZE } from "../../../src/features/review/queue.ts";
import type { Store } from "../../../src/features/vocabulary/store.ts";
import {
  announceGrade,
  announceSessionSize,
  canGrade,
  changeSessionSize,
  currentItem,
  gradeCurrent,
  isSessionComplete,
  reveal,
  startSession,
} from "../../../src/ui/review/reviewSession.ts";
import { memStore } from "../../vocabulary/memStore.ts";

const anchor: Anchor = {
  quote: "w",
  locator: { kind: "text", blockId: "b1", start: 0, end: 1 },
  anchorState: "resolved",
};

let store: Store;

beforeEach(async () => {
  store = memStore();
  for (const surface of ["ubiquitous", "leverage", "salient"]) {
    await capture(store, {
      surface,
      anchor: { ...anchor, quote: surface },
      titleSnapshot: "Book",
      sentence: `A sentence with ${surface}.`,
      meaning: `${surface} in Indonesian`,
    });
  }
});

describe("review session", () => {
  it("shows the queue, requires a reveal, and grades Learning and Known", async () => {
    let session = await startSession(store);
    expect(session.queue.items).toHaveLength(3);
    expect(session.sessionSize).toBe(DAILY_SESSION_DEFAULT);
    expect(session.revealed).toBe(false);
    // a blind tap cannot grade
    expect(canGrade(session)).toBe(false);
    const blind = await gradeCurrent(store, session, "known");
    expect(blind.outcome.kind).toBe("failed");
    expect(blind.session.index).toBe(0);

    session = reveal(session);
    expect(canGrade(session)).toBe(true);
    const item = currentItem(session)!;
    expect(item.vocabulary.meaning).toBeTruthy();
    expect(item.sentence).toContain(item.vocabulary.surface);

    const graded = await gradeCurrent(store, session, "again");
    expect(graded.outcome).toMatchObject({ kind: "recorded", grade: "again", returnedToQueue: true, duplicate: false });
    expect(graded.session.done).toBe(1);
    expect(graded.session.revealed).toBe(false);
    expect(announceGrade(graded.outcome)).toBe("Recorded as Learning.");

    const events = (await store.reviewEvents.toArray()) as ReviewEvent[];
    expect(events).toHaveLength(1);
    expect(events[0]!.cardId).toBe(item.vocabulary.id);

    // the Learning card comes back at the end of this session
    expect(graded.session.queue.items).toHaveLength(4);
    expect(graded.session.queue.items[3]!.vocabulary.id).toBe(item.vocabulary.id);

    const known = await gradeCurrent(store, reveal(graded.session), "known");
    expect(known.outcome).toMatchObject({ kind: "recorded", grade: "known", returnedToQueue: false });
    expect(announceGrade(known.outcome)).toBe("Recorded as Known.");
    const card = (await store.reviewCards.get(known.outcome.kind === "recorded" ? known.outcome.vocabularyId : "")) as
      | { suspended: boolean }
      | undefined;
    expect(card?.suspended).toBe(true);
  });

  it("finishes the session once every card is gone from it", async () => {
    let session = await startSession(store, 1);
    expect(session.queue.overflow).toBe(2);
    session = (await gradeCurrent(store, reveal(session), "got-it")).session;
    // got-it keeps the card in play, so the single-card session grows by one
    expect(session.queue.items).toHaveLength(2);
    session = (await gradeCurrent(store, reveal(session), "known")).session;
    session = (await gradeCurrent(store, reveal(session), "known")).session;
    expect(isSessionComplete(session)).toBe(true);
  });

  it("records one event for a double tap on the same card", async () => {
    const session = reveal(await startSession(store));
    const id = currentItem(session)!.vocabulary.id;
    const first = await gradeCurrent(store, session, "again", 1000);
    // same index, same grade, same event id: applyGrade drops the replay
    const second = await gradeCurrent(store, session, "again", 1000);
    expect(first.outcome.kind).toBe("recorded");
    expect(second.outcome).toMatchObject({ kind: "recorded", duplicate: true });
    expect(announceGrade(second.outcome)).toBe("Already recorded as Learning.");
    const events = ((await store.reviewEvents.toArray()) as ReviewEvent[]).filter((e) => e.cardId === id);
    expect(events).toHaveLength(1);
  });

  it("keeps the card, the reveal and the error when the write fails", async () => {
    const session = reveal(await startSession(store));
    const failing: Store = {
      ...store,
      transaction: () => Promise.reject(new Error("database is closed")),
    };
    const { session: after, outcome } = await gradeCurrent(failing, session, "again");
    expect(outcome).toEqual({ kind: "failed", grade: "again", vocabularyId: currentItem(session)!.vocabulary.id, message: "database is closed" });
    expect(announceGrade(outcome)).toBe("Not recorded: database is closed");
    expect(after.index).toBe(session.index);
    expect(after.revealed).toBe(true);
    expect(after.error).toBe("database is closed");
    expect(await store.reviewEvents.count()).toBe(0);
    // the learner can retry from the same card
    const retry = await gradeCurrent(store, after, "again");
    expect(retry.outcome.kind).toBe("recorded");
  });

  it("honours the daily session size setting and refuses out-of-range values", async () => {
    expect((await changeSessionSize(store, 7))).toEqual({ kind: "saved", size: 7 });
    expect(announceSessionSize({ kind: "saved", size: 7 })).toBe("Session size set to 7 words.");
    const row = (await store.settings.get(SETTING_DAILY_SESSION_SIZE)) as { value: unknown } | undefined;
    expect(row?.value).toBe(7);

    const session = await startSession(store);
    expect(session.sessionSize).toBe(7);
    expect(session.queue.items).toHaveLength(3);
    expect(session.queue.overflow).toBe(0);

    // out of range is refused outright; a fractional spinner value is truncated, not rejected
    for (const bad of [0, 201, -3]) {
      const outcome = await changeSessionSize(store, bad);
      expect(outcome.kind).toBe("failed");
      expect(announceSessionSize(outcome)).toMatch(/unchanged/);
    }
    expect(((await store.settings.get(SETTING_DAILY_SESSION_SIZE)) as { value: unknown }).value).toBe(7);
    expect(await changeSessionSize(store, 12.6)).toEqual({ kind: "saved", size: 12 });
  });
});