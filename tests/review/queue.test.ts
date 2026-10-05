import { withFailingPut } from "../faults.ts";
import { db, type AppDB } from "../../src/db/index.ts";
import { describe, expect, it } from "vitest";
import type { ReviewEvent } from "../../src/db/index.ts";
import {
  DAILY_SESSION_DEFAULT,
  SETTING_DAILY_SESSION_SIZE,
  applyGrade,
  buildQueue,
  eventsFor,
  getDailySessionSize,
  setDailySessionSize,
  stateFromEvents,
} from "../../src/features/review/queue.ts";
import { capture } from "../../src/features/vocabulary/capture.ts";

const base = {
  anchor: { quote: "w", locator: { kind: "text" as const, blockId: "b1", start: 0, end: 1 }, anchorState: "resolved" as const },
  titleSnapshot: "Book",
  sentence: "A sentence.",
  documentId: "doc-1",
};

/** makes a missing vocabularyId a loud failure instead of a silent `undefined` */
const missing = (): string => {
  throw new Error("seeded returned fewer ids than terms");
};

/** one saved word per term, positionally matched to the caller's destructuring */
async function seeded(store: AppDB, terms: { surface: string; meaning?: string; sentence?: string }[]): Promise<string[]> {
  const ids: string[] = [];
  let t = 0;
  for (const term of terms) {
    const res = await capture(store, { ...base, ...term, meaning: term.meaning ?? term.surface }, { now: ++t });
    ids.push(res.vocabulary.id);
  }
  return ids;
}

const store = db;

describe("queue order", () => {
  it("puts the least recently reviewed first and never reviewed first of all", async () => {
    const [a = missing(), b = missing(), c = missing()] = await seeded(store, [{ surface: "a" }, { surface: "b" }, { surface: "c" }]);

    await applyGrade(store, a, "got-it", "e1", 500);
    await applyGrade(store, b, "got-it", "e2", 900);

    const queue = await buildQueue(store, 10);
    expect(queue.items.map((i) => i.vocabulary.id)).toEqual([c, a, b]);
  });

  it("shows the word, the original sentence and the saved meaning", async () => {
    const [a = missing()] = await seeded(store, [{ surface: "leverage", meaning: "memanfaatkan", sentence: "They leverage focus." }]);
    const queue = await buildQueue(store, 10);
    expect(queue.items[0]).toMatchObject({
      sentence: "They leverage focus.",
      vocabulary: { id: a, surface: "leverage", meaning: "memanfaatkan" },
    });
  });

  it("honours the learner-chosen session size and reports the overflow", async () => {
    await seeded(store, [{ surface: "a" }, { surface: "b" }, { surface: "c" }, { surface: "d" }]);
    expect(await getDailySessionSize(store)).toBe(DAILY_SESSION_DEFAULT);
    await setDailySessionSize(store, 2);
    expect(await getDailySessionSize(store)).toBe(2);

    const queue = await buildQueue(store);
    expect(queue.items).toHaveLength(2);
    expect(queue.overflow).toBe(2);
    expect(queue.sessionSize).toBe(2);
    expect((await store.settings.toArray()).map((s) => (s as { key: string }).key)).toContain(SETTING_DAILY_SESSION_SIZE);
  });

  it("rejects an absurd session size instead of storing it", async () => {
    await expect(setDailySessionSize(store, 0)).rejects.toThrow(RangeError);
    await expect(setDailySessionSize(store, 1e6)).rejects.toThrow(RangeError);
  });

  it("excludes Known cards and resumes them as Learning", async () => {
    const [a = missing()] = await seeded(store, [{ surface: "a" }, { surface: "b" }]);
    await applyGrade(store, a, "known", "e1", 10);
    expect((await buildQueue(store, 10)).items.map((i) => i.vocabulary.id)).not.toContain(a);

    await applyGrade(store, a, "again", "e2", 20);
    const resumed = (await buildQueue(store, 10)).items.map((i) => i.vocabulary.id);
    expect(resumed).toContain(a);
    expect((await store.vocabulary.get(a)) as { status: string }).toMatchObject({ status: "learning" });
  });
});

describe("review events", () => {
  it("records one event per action", async () => {
    const [a = missing()] = await seeded(store, [{ surface: "a" }]);
    const res = await applyGrade(store, a, "got-it", "e1", 1000);
    expect(res.duplicate).toBe(false);
    expect(res.event).toMatchObject({ id: "e1", cardId: a, grade: "got-it", stageBefore: 0, stageAfter: 0, reviewedAt: 1000 });
    expect(await eventsFor(store, a)).toHaveLength(1);
  });

  it("writes nothing for a double tap on the same session event id", async () => {
    const [a = missing()] = await seeded(store, [{ surface: "a" }]);
    const first = await applyGrade(store, a, "got-it", "tap-1", 1000);
    const second = await applyGrade(store, a, "got-it", "tap-1", 1200);

    expect(second.duplicate).toBe(true);
    expect(second.event).toEqual(first.event);
    expect(await store.reviewEvents.count()).toBe(1);
    expect((await eventsFor(store, a))[0]?.reviewedAt).toBe(1000);
  });

  it("keeps distinct ids distinct", async () => {
    const [a = missing()] = await seeded(store, [{ surface: "a" }]);
    await applyGrade(store, a, "again", "tap-1", 1000);
    await applyGrade(store, a, "got-it", "tap-2", 2000);
    expect(await eventsFor(store, a)).toHaveLength(2);
  });

  it("reproduces card state from events alone", async () => {
    const [a = missing()] = await seeded(store, [{ surface: "a" }]);
    await applyGrade(store, a, "got-it", "e1", 100);
    await applyGrade(store, a, "known", "e2", 200);

    const events = (await store.reviewEvents.toArray()) as ReviewEvent[];
    const rebuilt = await stateFromEvents(events, a);
    expect(rebuilt).toEqual(await store.reviewCards.get(a));
    expect(rebuilt).toMatchObject({ stage: 0, lastReviewedAt: 200, suspended: true });
    expect(await stateFromEvents(events, "unknown")).toBeUndefined();
  });

  it("rolls back the card and vocabulary write when the event write fails", async () => {
    const [a = missing()] = await seeded(store, [{ surface: "a" }]);
    const broken = withFailingPut("reviewEvents", "QuotaExceeded");
    await expect(applyGrade(broken, a, "known", "e1", 100)).rejects.toThrow("QuotaExceeded");

    // neither the card nor the word moved: no half-graded state
    const card = (await store.reviewCards.get(a)) as { suspended: boolean; lastReviewedAt?: number };
    expect(card.suspended).toBe(false);
    expect(card.lastReviewedAt).toBeUndefined();
    expect((await store.vocabulary.get(a)) as { status: string }).toMatchObject({ status: "learning" });
    expect(await store.reviewEvents.count()).toBe(0);
  });
});