/**
 * Vocabulary screen: the saved words, their meanings, where they were seen, and
 * the original explanation kept visibly separate from the user's meaning.
 *
 * Reads and writes go through `ui/vocab/vocabularyPage.ts`, which calls Track F's
 * `listVocabulary` / `occurrencesOf` / `editMeaning`. No write result is
 * displayed before the write resolved.
 */

import { useCallback, useEffect, useId, useState } from "react";

import { db } from "../db/index.ts";
import { trackFStore } from "../features/vocabulary/store.ts";
import {
  announceEdit,
  loadVocabulary,
  saveMeaning,
  type VocabularyPage,
  type VocabularyRow,
} from "../ui/vocab/vocabularyPage.ts";

/*
 * The four blocks of a word are separated by shape and weight, not by colour
 * alone, so the distinction survives a monochrome display and a colour-blind
 * reader: the surface form is the largest serif text, the user's meaning is a
 * solid-bordered block, and the generated explanation is a dashed, tinted block.
 * Every pair of buttons carries its own text, so nothing is signalled by hue.
 */
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const FOCUS_FIELD = "focus:outline-2 focus:outline-offset-2 focus:outline-accent";
const BTN =
  `inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${FOCUS} disabled:cursor-not-allowed disabled:opacity-50`;
const BTN_PRIMARY = `${BTN} bg-accent text-paper hover:bg-accent/90`;
const BTN_SECONDARY = `${BTN} border border-line bg-paper text-ink hover:border-ink/30 hover:bg-shell`;
const BTN_QUIET = `${BTN} px-3 text-ink-soft hover:bg-shell hover:text-ink`;

const FIELD_LABEL = "block text-xs font-semibold uppercase tracking-wide text-ink-soft";
const BLOCK_LABEL = "block text-[11px] font-semibold uppercase tracking-wide text-ink-soft";
const FIELD =
  `mt-1.5 w-full rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink transition-colors placeholder:text-ink-soft/70 ${FOCUS_FIELD}`;

/** `status` is a stored field, so each tone is a literal string Tailwind sees. */
const statusChip = (status: "learning" | "known" | "suspended"): string =>
  status === "learning"
    ? "border-accent/40 bg-accent-soft text-accent"
    : status === "known"
      ? "border-line bg-shell text-ink"
      : "border-line border-dashed bg-paper text-ink-soft";

export function VocabularyScreen() {
  const [page, setPage] = useState<VocabularyPage | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | "learning" | "known">("all");
  const [announcement, setAnnouncement] = useState("");
  const headingId = useId();

  const refresh = useCallback(
    async (q: string, s: "all" | "learning" | "known") => {
      const titles = new Set((await db.documents.toArray()).map((d) => d.id));
      setPage(await loadVocabulary(trackFStore, { query: q, status: s }, titles));
    },
    [],
  );

  useEffect(() => {
    void refresh(query, status);
  }, [refresh, query, status]);

  const onSave = useCallback(
    async (row: VocabularyRow, meaning: string) => {
      const outcome = await saveMeaning(trackFStore, row.vocabulary.id, meaning);
      setAnnouncement(announceEdit(row.vocabulary.surface, outcome));
      await refresh(query, status);
    },
    [query, refresh, status],
  );

  return (
    <section aria-labelledby={headingId} className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-8">
      <header>
        <h1 id={headingId} className="text-2xl font-semibold tracking-tight text-ink">
          Vocabulary
        </h1>
        <p className="mt-1 text-sm text-ink-soft">Words you saved while reading, with where you met them.</p>
      </header>

      <div className="mt-5 grid gap-3 rounded-xl border border-line bg-paper p-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <label className="block">
          <span className={FIELD_LABEL}>Search saved words</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="word or meaning"
            className={FIELD}
          />
        </label>
        <label className="block">
          <span className={FIELD_LABEL}>Show</span>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as "all" | "learning" | "known")}
            className={`${FIELD} cursor-pointer`}
          >
            <option value="all">All</option>
            <option value="learning">Learning</option>
            <option value="known">Known</option>
          </select>
        </label>
      </div>

      {/* the live region stays mounted while empty, so the edit is announced */}
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

      <p aria-live="polite" className="mt-4 text-xs font-medium uppercase tracking-wide text-ink-soft">
        {page === null ? "" : `${page.filtered} of ${page.total} saved words`}
      </p>

      {page !== null && page.rows.length === 0 && (
        <p className="mt-4 rounded-xl border border-dashed border-line bg-paper px-6 py-10 text-center text-sm text-ink-soft">
          Nothing saved yet. Select a word while reading and choose “Save to vocabulary”.
        </p>
      )}

      <ul className="mt-4 space-y-3" aria-label="Saved words">
        {(page?.rows ?? []).map((row) => (
          <li key={row.vocabulary.id}>
            <VocabularyRowView row={row} onSave={onSave} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function VocabularyRowView({ row, onSave }: { row: VocabularyRow; onSave: (row: VocabularyRow, meaning: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(row.vocabulary.meaning);
  const inputId = useId();

  return (
    <article className="rounded-xl border border-line bg-paper p-4 shadow-sm sm:p-5">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        {/* the surface form is the entry's headline: largest text on the card */}
        <h2 className="font-read text-2xl font-semibold leading-tight text-ink">{row.vocabulary.surface}</h2>
        {row.vocabulary.lemma !== undefined && row.vocabulary.lemma !== row.vocabulary.surface && (
          <span className="text-sm italic text-ink-soft">of {row.vocabulary.lemma}</span>
        )}
        <span
          className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${statusChip(row.vocabulary.status)}`}
        >
          {row.vocabulary.status}
        </span>
      </div>

      <div className="mt-3 rounded-lg border border-line bg-shell p-3">
        <span className={BLOCK_LABEL}>Your meaning</span>
        {editing ? (
          <>
            <label className="sr-only" htmlFor={inputId}>
              Meaning for {row.vocabulary.surface}
            </label>
            <textarea
              id={inputId}
              value={draft}
              rows={2}
              onChange={(e) => setDraft(e.target.value)}
              autoFocus
              className={`${FIELD} resize-y`}
            />
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                className={BTN_PRIMARY}
                onClick={() => {
                  setEditing(false);
                  void onSave(row, draft);
                }}
              >
                Save meaning
              </button>
              <button type="button" className={BTN_SECONDARY} onClick={() => { setDraft(row.vocabulary.meaning); setEditing(false); }}>
                Cancel
              </button>
            </div>
          </>
        ) : (
          <div className="mt-1 flex flex-wrap items-start gap-x-3 gap-y-1">
            <p className="min-w-0 flex-1 text-sm text-ink">{row.vocabulary.meaning}</p>
            <button type="button" className={BTN_QUIET} onClick={() => setEditing(true)} aria-label={`Edit the meaning of ${row.vocabulary.surface}`}>
              Edit meaning
            </button>
          </div>
        )}
      </div>

      {/*
        The generated explanation is user data of its own. Editing the meaning
        above must never change it, so it gets its own labelled block — dashed
        border, tinted ground and serif type, so it can never be mistaken for
        the solid, plain block above.
      */}
      {row.originalExplanation !== null && (
        <div className="mt-2.5 rounded-lg border border-dashed border-accent/50 bg-accent-soft p-3">
          <span className={BLOCK_LABEL}>
            Original explanation{row.meaningEdited ? " (you edited your meaning above)" : ""}
          </span>
          <p className="mt-1 font-read text-sm leading-relaxed text-ink-soft">{row.originalExplanation}</p>
        </div>
      )}

      {row.vocabulary.note !== undefined && row.vocabulary.note !== "" && (
        <p className="mt-2.5 rounded-lg border-l-2 border-line pl-3 text-sm text-ink-soft">
          <span className={BLOCK_LABEL}>Note</span> {row.vocabulary.note}
        </p>
      )}

      <details className="group mt-3 rounded-lg border border-line">
        {/* `flex` on the summary drops the default disclosure marker; the chevron replaces it */}
        <summary
          className={`flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-ink transition-colors hover:bg-shell ${FOCUS}`}
        >
          <span aria-hidden="true" className="text-xs text-ink-soft transition-transform group-open:rotate-90">
            &#9656;
          </span>
          Seen {row.occurrences.length === 0 ? "nowhere yet" : `${row.occurrences.length} time${row.occurrences.length === 1 ? "" : "s"}`}
        </summary>
        {/* `sourcesUnavailable` is a property of the WORD, not of one
            occurrence. Inside the loop it repeated on every row of the same
            word, implying each sighting was broken. */}
        {row.sourcesUnavailable && (
          <p className="border-t border-line px-3 pt-2.5 text-xs text-ink-soft">
            Some source books are no longer on this device; the saved words are kept.
          </p>
        )}
        <ul className="space-y-2.5 border-t border-line px-3 py-2.5">
          {row.occurrences.map((o) => (
            <li key={o.id}>
              <span className="block text-xs text-ink-soft">
                {o.titleSnapshot}
                {o.anchor.locator.kind === "pdf" && ` · page ${o.anchor.locator.pageIndex + 1}`}
              </span>
              {o.sentence !== "" && <q className="mt-0.5 block font-read text-sm text-ink">{o.sentence}</q>}
            </li>
          ))}
        </ul>
      </details>
    </article>
  );
}