import { describe, expect, it } from "vitest";
import {
  DEFAULT_WATCHDOG_MS,
  DESKTOP_RADIUS,
  PHONE_RADIUS,
  cancelActive,
  completeJob,
  emptyQueue,
  enqueue,
  enqueueBounded,
  isObsolete,
  nextJob,
  semanticWindow,
  shouldTerminate,
} from "../../src/document/jobs.ts";
import type { Job } from "../../src/document/jobs.ts";

const job = (id: string, pageIndexes: number[], priority: Job["priority"] = "idle"): Job => ({ id, pageIndexes, priority });

describe("semanticWindow", () => {
  it("takes the visible page plus two pages each side on desktop", () => {
    expect(semanticWindow({ visiblePageIndex: 10, pageCount: 40, radius: DESKTOP_RADIUS })).toEqual([8, 9, 10, 11, 12]);
  });

  it("takes one page each side on a phone", () => {
    expect(semanticWindow({ visiblePageIndex: 10, pageCount: 40, radius: PHONE_RADIUS })).toEqual([9, 10, 11]);
  });

  it("clamps at both ends instead of going out of range", () => {
    expect(semanticWindow({ visiblePageIndex: 0, pageCount: 3, radius: DESKTOP_RADIUS })).toEqual([0, 1, 2]);
    expect(semanticWindow({ visiblePageIndex: 2, pageCount: 3, radius: DESKTOP_RADIUS })).toEqual([0, 1, 2]);
    expect(semanticWindow({ visiblePageIndex: 99, pageCount: 3, radius: DESKTOP_RADIUS })).toEqual([0, 1, 2]);
  });

  it("survives a zero or negative page count", () => {
    expect(semanticWindow({ visiblePageIndex: 0, pageCount: 0, radius: DESKTOP_RADIUS })).toEqual([]);
  });
});

describe("job queue", () => {
  it("runs the visible page before adjacent context and idle work", () => {
    let s = emptyQueue();
    s = enqueue(s, job("idle", [90]));
    s = enqueue(s, job("adjacent", [12]));
    s = enqueue(s, job("visible", [10]));
    s = enqueue(s, job("visible-later", [11]));

    const first = nextJob(s);
    expect(first.job?.id).toBe("visible");
    s = completeJob(first.state, first.job!);

    const second = nextJob(s);
    expect(second.job?.id).toBe("visible-later");
    s = completeJob(second.state, second.job!);

    expect(nextJob(s).job?.id).toBe("adjacent");
  });

  it("runs one job at a time", () => {
    const s = enqueue(enqueue(emptyQueue(), job("a", [1])), job("b", [2]));
    const first = nextJob(s);
    expect(first.job?.id).toBe("a");
    // The queue is busy now, so no second job is handed out.
    expect(nextJob(first.state).job).toBeNull();
  });

  it("drops a queued job superseded by a wider request for the same pages", () => {
    let s = enqueue(emptyQueue(), job("narrow", [10, 11]));
    s = enqueue(s, job("wide", [9, 10, 11, 12]));
    expect(s.queued.map((j) => j.id)).toEqual(["wide"]);
    expect(s.cancelled.map((j) => j.id)).toEqual(["narrow"]);
  });

  it("keeps queued work the new request does not cover", () => {
    let s = enqueue(emptyQueue(), job("far", [80]));
    s = enqueue(s, job("near", [10, 11]));
    expect(s.queued.map((j) => j.id)).toEqual(["near", "far"]);
  });

  it("deduplicates a request for pages already running", () => {
    let s = enqueue(emptyQueue(), job("a", [10, 11], "visible"));
    s = nextJob(s).state;
    const after = enqueue(s, job("same", [10, 11], "visible"));
    expect(after.queued).toEqual([]);
  });

  it("bounds the queue and reports the dropped work as cancelled, not done", () => {
    let s = emptyQueue();
    for (let i = 0; i < 12; i++) s = enqueueBounded(s, job(`j${i}`, [i]));
    expect(s.queued).toHaveLength(8);
    expect(s.cancelled).toHaveLength(4);
    expect(s.cancelled.map((j) => j.id)).toEqual(["j8", "j9", "j10", "j11"]);
  });

  it("recognises a job whose pages are all obsolete", () => {
    expect(isObsolete(job("a", [10, 11]), new Set([1, 2]))).toBe(true);
    expect(isObsolete(job("a", [10, 11]), new Set([10]))).toBe(false);
  });
});

describe("cancellation", () => {
  it("tells the caller that cancelling a synchronous WASM job needs worker termination", () => {
    const started = nextJob(enqueue(emptyQueue(), job("a", [1]))).state;
    const cancelled = cancelActive(started);
    // A queued message cannot interrupt a running synchronous call, so the
    // honest answer is "terminate the worker", not "send a cancel".
    expect(cancelled.mustTerminateWorker).toBe(true);
    expect(cancelled.state.active).toBeNull();
    expect(cancelled.state.cancelled.map((j) => j.id)).toEqual(["a"]);
  });

  it("needs no termination when nothing is running", () => {
    expect(cancelActive(emptyQueue()).mustTerminateWorker).toBe(false);
  });
});

describe("watchdog", () => {
  it("defaults to fifteen seconds", () => {
    expect(DEFAULT_WATCHDOG_MS).toBe(15_000);
    expect(emptyQueue().watchdogMs).toBe(15_000);
  });

  it("does not fire before the deadline, and not with no active job", () => {
    const s = nextJob(enqueue(emptyQueue(), job("a", [1]))).state;
    expect(shouldTerminate(s, 14_999)).toBe(false);
    expect(shouldTerminate(emptyQueue(), 99_999)).toBe(false);
  });

  it("fires once the deadline passes with a job running", () => {
    const s = nextJob(enqueue(emptyQueue(), job("a", [1]))).state;
    expect(shouldTerminate(s, 15_001)).toBe(true);
  });

  it("honours a configured deadline", () => {
    const s = nextJob(enqueue(emptyQueue(5_000), job("a", [1]))).state;
    expect(shouldTerminate(s, 5_001)).toBe(true);
    expect(shouldTerminate(s, 1_000)).toBe(false);
  });
});
