/**
 * Review screen: the queue, a reveal, Learning or Known, and the recorded event.
 *
 * The queue and the event writes are Track F's `buildQueue`/`applyGrade`, driven
 * by `ui/review/reviewSession.ts`. A failed write keeps the card, the reveal and
 * the focus, so the learner can retry without losing their place.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";

import type { ReviewGrade } from "../contracts/index.ts";
import { getDailySessionSize } from "../features/review/queue.ts";
import { trackFStore } from "../features/vocabulary/store.ts";
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
  type ReviewSession,
} from "../ui/review/reviewSession.ts";

/*
 * The card has two visually distinct phases. Hidden: a dashed, empty-looking
 * panel with a single primary "Show meaning" button. Revealed: a solid, filled
 * answer panel plus a bordered group of three grade buttons. The two can never
 * be mistaken for one another, and every grade is named in text, so the choice
 * is never carried by colour alone.
 */
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const BTN =
  `inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors ${FOCUS} disabled:cursor-not-allowed disabled:opacity-50`;
const BTN_PRIMARY = `${BTN} bg-accent text-paper hover:bg-accent/90`;
const BTN_SECONDARY = `${BTN} border border-line bg-paper text-ink hover:border-ink/30 hover:bg-shell`;

const FIELD_LABEL = "block text-xs font-semibold uppercase tracking-wide text-ink-soft";
const BLOCK_LABEL = "block text-xs font-semibold uppercase tracking-wide text-ink-soft";
const FIELD =
  "mt-1.5 w-24 rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink transition-colors focus:outline-2 focus:outline-offset-2 focus:outline-accent";

export function ReviewScreen() {
  const [session, setSession] = useState<ReviewSession | null>(null);
  const [sizeDraft, setSizeDraft] = useState(20);
  const [announcement, setAnnouncement] = useState("");
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  const begin = useCallback(async () => {
    setSession(await startSession(trackFStore));
    setAnnouncement("");
  }, []);

  useEffect(() => {
    void (async () => {
      setSizeDraft(await getDailySessionSize(trackFStore));
      await begin();
    })();
  }, [begin]);

  const onGrade = useCallback(
    async (grade: ReviewGrade) => {
      if (session === null) return;
      const { session: next, outcome } = await gradeCurrent(trackFStore, session, grade);
      setSession(next);
      setAnnouncement(announceGrade(outcome));
      // the next card is new content; move the reading position to it
      window.requestAnimationFrame(() => headingRef.current?.focus());
    },
    [session],
  );

  const onSize = useCallback(async () => {
    const outcome = await changeSessionSize(trackFStore, sizeDraft);
    setAnnouncement(announceSessionSize(outcome));
    if (outcome.kind === "saved") await begin();
  }, [begin, sizeDraft]);

  const item = session === null ? undefined : currentItem(session);
  // `session === null` is the loading state, not a completed session: isSessionComplete
  // dereferences the queue, so it must never be handed null.
  const done = session !== null && isSessionComplete(session);

  return (
    <section aria-labelledby={headingId} className="mx-auto w-full max-w-2xl px-4 py-4 sm:px-6 sm:py-6">
      <header>
        <h1 id={headingId} className="text-2xl font-semibold tracking-tight text-ink">
          Review
        </h1>
        <p className="mt-1 text-sm text-ink-soft">Recall the meaning first, then grade yourself honestly.</p>
      </header>

      {/* `items-end` aligns the buttons with the input instead of guessing a
          margin that would drift when the label wraps */}
      <div className="mt-5 flex flex-wrap items-end gap-2 rounded-xl border border-line bg-paper p-4">
        <label className="block">
          <span className={FIELD_LABEL}>Words per session</span>
          <input
            type="number"
            min={1}
            max={200}
            value={sizeDraft}
            onChange={(e) => setSizeDraft(Number(e.target.value))}
            onBlur={() => void onSize()}
            className={FIELD}
          />
        </label>
        <button type="button" className={BTN_SECONDARY} onClick={() => void onSize()}>
          Apply session size
        </button>
        <button type="button" className={BTN_SECONDARY} onClick={() => void begin()}>
          Start over
        </button>
      </div>

      <p
        role="status"
        aria-live="polite"
        className={
          announcement === ""
            ? "sr-only"
            : "mt-3 rounded-lg border border-accent/40 bg-accent-soft px-3 py-2 text-sm text-ink"
        }
      >
        {announcement}
      </p>

      {session === null && (
        <p className="mt-6 rounded-xl border border-dashed border-line bg-paper px-6 py-10 text-center text-sm text-ink-soft">
          Loading your queue…
        </p>
      )}

      {session !== null && done && (
        <p className="mt-6 rounded-xl border border-dashed border-line bg-paper px-6 py-10 text-center text-sm text-ink-soft">
          Session complete — {session.done} word{session.done === 1 ? "" : "s"} reviewed
          {session.queue.overflow > 0 && `, ${session.queue.overflow} more waiting for the next session`}.
        </p>
      )}

      {session !== null && item !== undefined && (
        <article className="mt-6 rounded-2xl border border-line bg-paper p-5 shadow-sm sm:p-7">
          <p aria-live="polite" className="text-xs font-semibold uppercase tracking-wide text-ink-soft">
            Word {session.done + 1} of {session.queue.items.length}
            {session.queue.overflow > 0 && ` · ${session.queue.overflow} more in your queue`}
          </p>

          <h2
            ref={headingRef}
            tabIndex={-1}
            className="mt-2 font-read text-4xl font-semibold leading-tight text-ink focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent sm:text-5xl"
          >
            {item.vocabulary.surface}
          </h2>

          {item.sentence !== undefined && item.sentence !== "" && (
            <q className="mt-3 block font-read text-base leading-relaxed text-ink-soft">{item.sentence}</q>
          )}

          {session.revealed ? (
            <>
              <div className="mt-5 rounded-xl border border-line bg-shell p-4">
                <span className={BLOCK_LABEL}>Your meaning</span>
                <p className="mt-1 text-base text-ink">{item.vocabulary.meaning}</p>
              </div>
              {item.vocabulary.explanationText !== undefined && (
                <div className="mt-2.5 rounded-xl border border-dashed border-accent/50 bg-accent-soft p-4">
                  <span className={BLOCK_LABEL}>Original explanation</span>
                  <p className="mt-1 font-read text-base leading-relaxed text-ink-soft">{item.vocabulary.explanationText}</p>
                </div>
              )}
              <div role="group" aria-label="Mark this word" className="mt-5 flex flex-wrap gap-2 border-t border-line pt-4">
                <button type="button" className={`${BTN_SECONDARY} min-w-28`} onClick={() => void onGrade("again")} disabled={!canGrade(session) || session.pending}>
                  Learning
                </button>
                <button type="button" className={`${BTN_SECONDARY} min-w-28`} onClick={() => void onGrade("got-it")} disabled={!canGrade(session) || session.pending}>
                  Got it
                </button>
                <button type="button" className={`${BTN_PRIMARY} min-w-28`} onClick={() => void onGrade("known")} disabled={!canGrade(session) || session.pending}>
                  Known
                </button>
              </div>
            </>
          ) : (
            <div className="mt-5 rounded-xl border border-dashed border-line p-5 text-center">
              <p className="text-sm text-ink-soft">Say the meaning out loud before you check yourself.</p>
              <div className="mt-3 flex justify-center">
                <button type="button" className={BTN_PRIMARY} onClick={() => setSession(reveal(session))}>
                  Show meaning
                </button>
              </div>
            </div>
          )}

          {session.error !== null && (
            <p className="mt-4 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
              {session.error} Nothing was recorded — try again.
            </p>
          )}
        </article>
      )}
    </section>
  );
}