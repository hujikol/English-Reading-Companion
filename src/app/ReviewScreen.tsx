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
    <section className="erc-screen" aria-labelledby={headingId}>
      <h1 id={headingId}>Review</h1>

      <div className="erc-toolbar">
        <label className="erc-field erc-field--inline">
          <span>Words per session</span>
          <input
            type="number"
            min={1}
            max={200}
            value={sizeDraft}
            onChange={(e) => setSizeDraft(Number(e.target.value))}
            onBlur={() => void onSize()}
          />
        </label>
        <button type="button" className="erc-btn" onClick={() => void onSize()}>
          Apply session size
        </button>
        <button type="button" className="erc-btn" onClick={() => void begin()}>
          Start over
        </button>
      </div>

      <p role="status" aria-live="polite" className="erc-notice">
        {announcement}
      </p>

      {session === null && <p className="erc-empty">Loading your queue…</p>}

      {session !== null && done && (
        <p className="erc-empty">
          Session complete — {session.done} word{session.done === 1 ? "" : "s"} reviewed
          {session.queue.overflow > 0 && `, ${session.queue.overflow} more waiting for the next session`}.
        </p>
      )}

      {session !== null && item !== undefined && (
        <article className="erc-review__card">
          <p className="erc-review__progress" aria-live="polite">
            Word {session.done + 1} of {session.queue.items.length}
            {session.queue.overflow > 0 && ` · ${session.queue.overflow} more in your queue`}
          </p>
          <h2 ref={headingRef} tabIndex={-1} className="erc-review__surface">
            {item.vocabulary.surface}
          </h2>
          {item.sentence !== undefined && item.sentence !== "" && <q className="erc-review__sentence">{item.sentence}</q>}

          {session.revealed ? (
            <>
              <div className="erc-review__answer">
                <span className="erc-label">Your meaning</span>
                <p>{item.vocabulary.meaning}</p>
              </div>
              {item.vocabulary.explanationText !== undefined && (
                <div className="erc-review__answer erc-review__answer--original">
                  <span className="erc-label">Original explanation</span>
                  <p>{item.vocabulary.explanationText}</p>
                </div>
              )}
              <div className="erc-actions" role="group" aria-label="Mark this word">
                <button type="button" className="erc-btn" onClick={() => void onGrade("again")} disabled={!canGrade(session) || session.pending}>
                  Learning
                </button>
                <button type="button" className="erc-btn" onClick={() => void onGrade("got-it")} disabled={!canGrade(session) || session.pending}>
                  Got it
                </button>
                <button type="button" className="erc-btn erc-btn--primary" onClick={() => void onGrade("known")} disabled={!canGrade(session) || session.pending}>
                  Known
                </button>
              </div>
            </>
          ) : (
            <div className="erc-actions">
              <button type="button" className="erc-btn erc-btn--primary" onClick={() => setSession(reveal(session))}>
                Show meaning
              </button>
            </div>
          )}

          {session.error !== null && <p className="erc-notice erc-notice--error">{session.error} Nothing was recorded — try again.</p>}
        </article>
      )}
    </section>
  );
}