/**
 * Section 6 display/semantic windows and Section 14 job scheduling, as PURE
 * functions. No timers, no worker handles: a caller owns the loop and calls
 * `nextJob` to learn what to run and `shouldTerminate` to learn whether to kill
 * the worker.
 *
 *   "Start with a semantic window of the current page plus two pages each side"
 *   "Use one active extraction job and a bounded queue. Priorities are visible
 *    page, adjacent context, then optional idle work. Deduplicate requests and
 *    drop obsolete queued jobs."
 *   "Use a configurable 15-second parser-job watchdog. Canceling a synchronous
 *    WASM call requires terminating its worker; a queued cancellation message
 *    cannot interrupt the running call."
 */

export const DESKTOP_RADIUS = 2;
export const PHONE_RADIUS = 1;
export const DEFAULT_WATCHDOG_MS = 15_000;

/** One extraction job. Pages are zero-based and already deduplicated upstream. */
export type Job = { id: string; pageIndexes: number[]; priority: Priority };

export type Priority = "visible" | "adjacent" | "idle";

export type WindowInput = {
  visiblePageIndex: number;
  pageCount: number;
  /** desktop: 2, phone: 1 (Section 6) */
  radius: number;
};

/** Visible page plus `radius` pages each side, clamped to the document. */
export const semanticWindow = ({ visiblePageIndex, pageCount, radius }: WindowInput): number[] => {
  if (pageCount <= 0) return [];
  const v = Math.max(0, Math.min(pageCount - 1, Math.trunc(visiblePageIndex)));
  const start = Math.max(0, v - radius);
  const end = Math.min(pageCount - 1, v + radius);
  const out: number[] = [];
  for (let i = start; i <= end; i++) out.push(i);
  return out;
};

export type QueueState = { active: Job | null; queued: Job[]; cancelled: Job[]; watchdogMs: number };

export const emptyQueue = (watchdogMs: number = DEFAULT_WATCHDOG_MS): QueueState => ({
  active: null,
  queued: [],
  cancelled: [],
  watchdogMs,
});

const RANK: Record<Priority, number> = { visible: 0, adjacent: 1, idle: 2 };
/** Priority order: visible, then adjacent context, then idle. Page order within
 *  a priority keeps the reading sequence stable. */
const sortJobs = (jobs: Job[]): Job[] =>
  [...jobs].sort((a, b) => RANK[a.priority] - RANK[b.priority] || (a.pageIndexes[0] ?? 0) - (b.pageIndexes[0] ?? 0));

/**
 * Enqueue a job. Supersedes rather than duplicates: if the new job's pages are a
 * superset of a queued job's pages, the queued job is dropped. Anything the new
 * job does not cover stays queued, already in priority order so that a visible
 * page can never sit behind idle work.
 */
export function enqueue(state: QueueState, job: Job): QueueState {
  if (state.active !== null && covers(job.pageIndexes, state.active.pageIndexes) && job.priority === state.active.priority)
    return state;
  const kept = state.queued.filter((q) => !covers(job.pageIndexes, q.pageIndexes));
  const cancelled = state.queued.filter((q) => covers(job.pageIndexes, q.pageIndexes));
  return { ...state, queued: sortJobs([...kept, job]), cancelled: [...state.cancelled, ...cancelled] };
}

const covers = (a: readonly number[], b: readonly number[]): boolean => {
  const set = new Set(a);
  return b.every((p) => set.has(p));
};

/** Take the next job. Returns the new state and the job to run, if any. */
export function nextJob(state: QueueState): { state: QueueState; job: Job | null } {
  if (state.active !== null) return { state, job: null };
  const [first, ...rest] = sortJobs(state.queued);
  if (first === undefined) return { state, job: null };
  return { state: { ...state, active: first, queued: rest }, job: first };
}

export const completeJob = (state: QueueState, job: Job): QueueState =>
  state.active?.id === job.id ? { ...state, active: null } : state;

/**
 * Cancel the active job. `mustTerminateWorker` is the honest answer to "does
 * cancelling stop the work": for a synchronous WASM call it does not, and the
 * caller must terminate the worker rather than post a cancel message.
 */
export const cancelActive = (state: QueueState): { state: QueueState; mustTerminateWorker: boolean } => {
  if (state.active === null) return { state, mustTerminateWorker: false };
  return {
    state: { ...state, active: null, cancelled: [...state.cancelled, state.active] },
    mustTerminateWorker: true,
  };
};

/**
 * Watchdog decision. Pure: the caller supplies elapsed time from its own clock,
 * so tests are deterministic and no timer is embedded.
 */
export const shouldTerminate = (state: QueueState, elapsedMs: number): boolean =>
  state.active !== null && elapsedMs > state.watchdogMs;

/**
 * Bounded queue: drop the lowest-priority job when full rather than growing.
 * The dropped job is reported so the caller can report it as never run, not as
 * completed.
 */
export const MAX_QUEUED_JOBS = 8;

export function enqueueBounded(state: QueueState, job: Job, max = MAX_QUEUED_JOBS): QueueState {
  const next = enqueue(state, job);
  if (next.queued.length <= max) return next;
  const sorted = sortJobs(next.queued);
  const keep = sorted.slice(0, max);
  const dropped = sorted.slice(max);
  return { ...next, queued: keep, cancelled: [...next.cancelled, ...dropped] };
}

/** True when the job is still wanted: none of its pages are obsolete. */
export const isObsolete = (job: Job, wanted: ReadonlySet<number>): boolean => job.pageIndexes.every((p) => !wanted.has(p));
