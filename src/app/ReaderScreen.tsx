import { useCallback, useEffect, useRef, useState } from "react";
import type { Anchor, Bookmark, Mark } from "../contracts/index.ts";
import { db, type DocumentRecord } from "../db/index.ts";
import { importDocument } from "../ui/library/libraryModel.ts";
import { openRawDocument, pageFromInput, sameUnit, type RawDocument, type ReadingUnit } from "../ui/reader/rawDocument.ts";
import { readSelection } from "../ui/reader/selection.ts";
import { sentenceAround } from "../ui/reader/popoverBridge.ts";
import { contextAround, disambiguate } from "../features/selection/anchor.ts";
import { dbProgressStore, newMarkId, readBookmarks, readMarks, writeBookmark } from "../ui/reader/stores.ts";
import { initialProgressState, persistProgress, type ProgressState } from "../features/library/progress.ts";
import { makeBookmark, softDelete } from "../features/library/bookmarks.ts";
import { deleteMark } from "../features/marks/save.ts";
import { PdfPasswordRequiredError } from "../features/reader/pdf/adapter.ts";
import { SelectionPopover } from "../ui/SelectionPopover.tsx";
import { lookupSurface } from "../ui/vocab/dictionaryLookup.ts";
import { dismissPopover, initialPopoverState, openPopover, type PopoverState, type AiAvailability } from "../ui/vocab/selectionPopover.ts";
import { BTN_PRIMARY, BTN_SECONDARY, BTN_SM, BTN_ICON } from "../ui/styles.ts";

const SWATCH = { yellow: "bg-yellow-200", green: "bg-green-200", blue: "bg-blue-200", pink: "bg-pink-200" };
export type ReaderScreenProps = {
  pendingDocument?: File | undefined;
  pendingRecord?: DocumentRecord | undefined;
  packAttribution?: { source: string; license: string; packVersion?: string } | null;
  dictLoading?: boolean;
  ai?: AiAvailability;
  localProgress?: string;
};

export function ReaderScreen({ pendingDocument, pendingRecord, packAttribution = null, dictLoading = false, ai, localProgress }: ReaderScreenProps = {}) {
  const [record, setRecord] = useState<DocumentRecord>();
  const [reader, setReader] = useState<RawDocument>();
  const [unit, setUnit] = useState<ReadingUnit>();
  const [page, setPage] = useState(0);
  const [mode, setMode] = useState<"single" | "scroll">("single");
  const [nearby, setNearby] = useState<number[]>([]);
  const [parsedUnits, setParsedUnits] = useState<Map<number, ReadingUnit>>(new Map());
  const pendingScroll = useRef<number>();
  const pages = useRef(new Map<number, HTMLElement>());
  const heights = useRef(new Map<number, number>());
  const [draft, setDraft] = useState("");
  const [fontSize, setFontSize] = useState(20);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [locked, setLocked] = useState<File>();
  const [password, setPassword] = useState("");
  const [marks, setMarks] = useState<Mark[]>([]);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [popover, setPopover] = useState<PopoverState>(initialPopoverState);
  const [jump, setJump] = useState<Mark>();
  const textRef = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const activeReader = useRef<RawDocument>();
  const generation = useRef(0);
  const progress = useRef<ProgressState>();
  const writes = useRef(Promise.resolve());
  const fileInput = useRef<HTMLInputElement>(null);

  const openFile = useCallback(async (file: File, known?: DocumentRecord, suppliedPassword?: string) => {
    const token = ++generation.current;
    setBusy(true); setError(""); setNotice(""); setUnit(undefined);
    setReader(undefined); setRecord(undefined); setMarks([]); setBookmarks([]);
    setPopover(initialPopoverState); setJump(undefined); setParsedUnits(new Map()); heights.current.clear();
    let parsed: RawDocument | undefined;
    try {
      await writes.current;
      parsed = await openRawDocument(file, suppliedPassword);
      if (token !== generation.current) { await parsed.close(); return; }
      let document = known;
      if (!document) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const outcome = await importDocument({ name: file.name, type: file.type, size: file.size, bytes, head: bytes.subarray(0, 1024) }, {
          findByHash: hash => db.documents.where("contentHash").equals(hash).first(),
          persist: async (row, blob) => { await db.transaction("rw", [db.documents, db.assets], async () => {
            await db.documents.put(row);
            await db.assets.put({ documentId: row.id, blob, mime: blob.type, byteSize: blob.size, checksum: row.contentHash ?? "" });
          }); },
        });
        if (outcome.kind === "rejected") throw new Error(outcome.errors.map(e => e.message).join(" "));
        document = outcome.document;
        if (outcome.kind === "temporary") setNotice(`Temporary session: ${outcome.message}`);
      }
      const saved = await dbProgressStore.read(document.id);
      const [savedMarks, savedBookmarks] = await Promise.all([readMarks(document.id), readBookmarks(document.id)]);
      if (token !== generation.current) { await parsed.close(); return; }
      const old = activeReader.current;
      activeReader.current = parsed;
      setReader(parsed); setRecord(document); setPage(parsed.indexOf(saved?.locator)); setDraft("");
      progress.current = initialProgressState(document.id, saved);
      setMarks(savedMarks); setBookmarks(savedBookmarks); setLocked(undefined); setPassword("");
      if (old) await old.close();
      await db.documents.update(document.id, { pageCount: parsed.count, lastOpenedAt: Date.now() });
    } catch (e) {
      if (parsed && parsed !== activeReader.current) await parsed.close();
      if (token !== generation.current) return;
      if (e instanceof PdfPasswordRequiredError) { setLocked(file); setError("Enter this PDF's password to read it."); }
      else setError(e instanceof Error ? e.message : "This file could not be opened.");
    } finally { if (token === generation.current) setBusy(false); }
  }, []);

  useEffect(() => {
    if (pendingDocument) void openFile(pendingDocument, pendingRecord);
  }, [pendingDocument, pendingRecord, openFile]);

  useEffect(() => () => {
    generation.current++;
    void activeReader.current?.close();
  }, []);

  useEffect(() => {
    if (!reader || busy) return;
    let live = true;
    setUnit(undefined); setError(""); setPopover(initialPopoverState);
    reader.read(page).then(next => {
      if (live) { setUnit(next); if (viewport.current && mode === "single") viewport.current.scrollTop = 0; }
    }).catch(e => { if (live) setError(e instanceof Error ? e.message : "Could not extract text."); });
    return () => { live = false; };
  }, [reader, page, busy, mode]);

  useEffect(() => {
    if (mode !== "scroll" || !reader || !viewport.current) return;
    const approaching = new Set<number>();
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const index = Number((entry.target as HTMLElement).dataset.page);
        if (entry.isIntersecting) approaching.add(index); else approaching.delete(index);
      }
      setNearby([...approaching].sort((a, b) => a - b));
    }, { root: viewport.current, rootMargin: "800px 0px" });
    const sizes = new ResizeObserver(entries => {
      for (const entry of entries) {
        const index = Number((entry.target as HTMLElement).dataset.page);
        if (entry.target.querySelector('[aria-label="Reading text"]')) heights.current.set(index, entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height);
      }
    });
    for (const element of pages.current.values()) { observer.observe(element); sizes.observe(element); }
    return () => { observer.disconnect(); sizes.disconnect(); };
  }, [mode, reader, busy]);

  useEffect(() => {
    if (mode !== "scroll" || !reader || busy) return;
    let live = true;
    const wanted = nearby.slice(0, 8);
    setParsedUnits(current => new Map([...current].filter(([index]) => wanted.includes(index))));
    void (async () => {
      // Sequential extraction bounds worker pressure; native scrolling continues during parsing.
      for (const index of wanted) {
        if (!live) break;
        try {
          const next = await reader.read(index);
          if (live) setParsedUnits(current => new Map(current).set(index, next));
        } catch (e) { if (live) setError(`Could not parse page ${index + 1}: ${String(e)}`); }
      }
    })();
    return () => { live = false; };
  }, [mode, reader, nearby, busy]);

  useEffect(() => {
    const target = pendingScroll.current;
    if (mode !== "scroll" || target === undefined || !parsedUnits.has(target)) return;
    const frame = requestAnimationFrame(() => {
      const element = pages.current.get(target);
      if (element && viewport.current) {
        viewport.current.scrollTop += element.getBoundingClientRect().top - viewport.current.getBoundingClientRect().top;
        setPage(target); pendingScroll.current = undefined;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [mode, parsedUnits]);

  // Serial writes retain revision order even when Next is clicked rapidly.
  useEffect(() => {
    if (!unit || !record || !reader || reader.indexOf(unit.locator) !== page) return;
    const next = { locator: unit.locator, progression: reader && reader.count > 1 ? page / (reader.count - 1) : 0 };
    writes.current = writes.current.then(async () => {
      const state = progress.current;
      if (!state || state.documentId !== record.id) return;
      const result = await persistProgress(state, next, dbProgressStore);
      progress.current = result.state;
      setNotice(result.outcome.kind === "saved" ? "Position saved" : result.outcome.kind === "conflict" ? "Another tab saved a newer position." : `Position not saved: ${result.outcome.message}`);
    }).catch(e => setNotice(`Position not saved: ${String(e)}`));
  }, [unit, record, page, reader]);

  const navigate = useCallback((index: number) => {
    if (!reader) return;
    const target = Math.max(0, Math.min(reader.count - 1, index));
    setPage(target); setDraft("");
    if (mode === "scroll") {
      pendingScroll.current = target;
      const element = pages.current.get(target);
      if (element && viewport.current) viewport.current.scrollTop += element.getBoundingClientRect().top - viewport.current.getBoundingClientRect().top;
    }
    setPopover(initialPopoverState); window.getSelection()?.removeAllRanges();
  }, [reader, mode]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!viewport.current?.getClientRects().length) return;
      if ((event.target as HTMLElement)?.closest("input, textarea, select, button") || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "PageDown" || event.key === "PageUp") {
        event.preventDefault(); navigate(page + (event.key === "PageDown" ? 1 : -1));
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [navigate, page]);

  const capture = (element: HTMLDivElement, selectedUnit: ReadingUnit) => {
    if (!record) return;
    const selection = readSelection(element);
    if (!selection?.viewportRect) return;
    const rect = selection.viewportRect;
    const anchor: Anchor = { quote: selection.quote, locator: selectedUnit.locator, anchorState: "resolved", ...contextAround(selectedUnit.text, selection.startInPage, selection.startInPage + selection.quote.length) };
    setPopover(current => openPopover(current, {
      surface: selection.quote.trim(), sentence: sentenceAround(selectedUnit.text, selection.startInPage, selection.quote),
      anchor, documentId: record.id, titleSnapshot: record.title, positionLabel: selectedUnit.label,
      rect: { top: rect.top, left: rect.left, bottom: rect.top + rect.height, right: rect.left + rect.width },
    }));
  };

  const addMark = async (color: Mark["color"]) => {
    if (!popover.selection || !record) return;
    const mark: Mark = { id: newMarkId(), documentId: record.id, titleSnapshot: record.title, anchor: popover.selection.anchor, color, createdAt: Date.now() };
    try { await db.marks.put(mark); setMarks(current => [...current, mark]); setNotice("Highlight saved"); }
    catch (e) { setNotice(`Highlight not saved: ${String(e)}`); }
  };
  const removeMark = async (mark: Mark) => {
    try { await db.marks.put(deleteMark(mark, Date.now())); setMarks(current => current.filter(m => m.id !== mark.id)); }
    catch (e) { setNotice(`Highlight not removed: ${String(e)}`); }
  };
  const bookmark = async () => {
    if (!record || !unit) return;
    const existing = bookmarks.find(b => sameUnit(b.locator, unit.locator));
    const row = existing ? softDelete(existing) : makeBookmark({ documentId: record.id, titleSnapshot: record.title, locator: unit.locator, label: unit.label });
    try {
      await writeBookmark(row);
      setBookmarks(current => existing ? current.filter(b => b.id !== existing.id) : [...current, row]);
      setNotice(existing ? "Bookmark removed" : "Bookmark saved");
    } catch (e) { setNotice(`Bookmark not saved: ${String(e)}`); }
  };

  useEffect(() => {
    if (!jump || !unit || !sameUnit(jump.anchor.locator, unit.locator)) return;
    if (mode === "scroll" && !parsedUnits.has(page)) return;
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(`mark-${jump.id}`);
      if (target) { if (viewport.current) viewport.current.scrollTop += target.getBoundingClientRect().top - viewport.current.getBoundingClientRect().top - viewport.current.clientHeight / 2;
        target.focus({ preventScroll: true }); setNotice("Jumped to highlight"); }
      else setNotice("This highlight could not be found in the extracted text.");
      setJump(undefined);
    });
    return () => cancelAnimationFrame(frame);
  }, [jump, unit, parsedUnits, mode, page]);

  const renderText = (readingUnit: ReadingUnit) => {
    const ranges = readingUnit ? marks.filter(m => sameUnit(m.anchor.locator, readingUnit.locator)).flatMap(mark => {
    const match = disambiguate(readingUnit.text, mark.anchor.quote, mark.anchor.prefix, mark.anchor.suffix);
    return match ? [{ mark, start: match.originalStart, end: match.originalEnd }] : [];
  }) : [];
  const boundaries = [...new Set([0, readingUnit.text.length ?? 0, ...ranges.flatMap(r => [r.start, r.end])])].sort((a, b) => a - b);
  const seen = new Set<string>();
    const text = boundaries.slice(0, -1).map((start, index) => {
    const end = boundaries[index + 1]!;
    const range = ranges.find(r => r.start <= start && r.end >= end);
    if (!range) return readingUnit.text.slice(start, end);
    const first = !seen.has(range.mark.id); seen.add(range.mark.id);
    return <mark key={start} id={first ? `mark-${range.mark.id}` : undefined} tabIndex={-1} className={`${SWATCH[range.mark.color]} rounded-sm text-ink focus:outline-2 focus:outline-accent`}>{readingUnit.text.slice(start, end)}</mark>;
  });

    return text;
  };
  const article = (readingUnit: ReadingUnit, index: number) => <article className="mx-auto w-full max-w-3xl rounded-xl border border-line bg-paper p-6 shadow-sm sm:p-10" aria-label={readingUnit.label}>
    <h1 className="mb-6 text-sm font-semibold text-ink-soft">{record?.title} · {readingUnit.label}</h1>
    {readingUnit.text.trim() ? <div ref={mode === "single" ? textRef : undefined}
      onMouseUp={e => capture(e.currentTarget, readingUnit)} onTouchEnd={e => capture(e.currentTarget, readingUnit)} onKeyUp={e => capture(e.currentTarget, readingUnit)}
      tabIndex={0} aria-label="Reading text" className="whitespace-pre-wrap break-words font-read leading-relaxed text-ink selection:bg-blue-200" style={{ fontSize }}>{renderText(readingUnit)}</div>
      : <p className="text-ink-soft">This page has no extractable text. Scanned pages need OCR before words can be selected.</p>}
    <span className="sr-only">Page {index + 1}</span>
  </article>;

  return <section className="flex h-full min-h-0 flex-col overflow-hidden">
    <div className="sticky top-0 z-30 flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-paper p-3" aria-label="Reader controls">
      <button className={BTN_PRIMARY} type="button" onClick={() => fileInput.current?.click()} disabled={busy}>Open a file</button>
      <input ref={fileInput} className="hidden" type="file" accept=".pdf,.epub,.txt,.md,.markdown" aria-label="Choose a document" onChange={e => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void openFile(file); }} />
      <button className={BTN_SECONDARY} type="button" aria-label="Previous page" disabled={!reader || busy || page === 0} onClick={() => navigate(page - 1)}>‹ Prev</button>
      <form className="flex items-center gap-2" onSubmit={e => { e.preventDefault(); const index = pageFromInput(draft, reader?.count ?? 0); if (index !== undefined) navigate(index); else setNotice("Enter a whole page number."); }}>
        <label className="sr-only" htmlFor="reader-page">Go to page</label>
        <input id="reader-page" type="text" inputMode="numeric" autoComplete="off" value={draft} placeholder={String(page + 1)} onChange={e => setDraft(e.target.value)} disabled={!reader || busy} className="h-11 w-20 rounded-lg border border-ink-soft bg-paper px-2 text-center text-ink" />
        <span className="text-sm text-ink-soft">/ {reader?.count ?? 0}</span>
        <button type="submit" className={BTN_SECONDARY} disabled={!reader || busy}>Go</button>
      </form>
      <button className={BTN_SECONDARY} type="button" aria-label="Next page" disabled={!reader || busy || page >= reader.count - 1} onClick={() => navigate(page + 1)}>Next ›</button>
      <div role="group" aria-label="Reading mode" className="flex gap-1 rounded-lg border border-line p-1">
        {(["single", "scroll"] as const).map(value => <button className={`${BTN_SM} ${mode === value ? "bg-accent text-white" : "text-ink"}`} key={value} type="button" aria-pressed={mode === value} onClick={() => {
          setMode(value); setNearby([page]); pendingScroll.current = value === "scroll" ? page : undefined;
          requestAnimationFrame(() => {
            const element = pages.current.get(page);
            if (value === "scroll" && element && viewport.current) viewport.current.scrollTop += element.getBoundingClientRect().top - viewport.current.getBoundingClientRect().top;
          });
        }}>{value === "single" ? "Paged" : "Scroll"}</button>)}
      </div>
      <button className={BTN_ICON} type="button" aria-label="Decrease text size" disabled={fontSize <= 14} onClick={() => setFontSize(size => size - 2)}>−</button>
      <span className="text-sm text-ink-soft">{fontSize}px</span>
      <button className={BTN_ICON} type="button" aria-label="Increase text size" disabled={fontSize >= 40} onClick={() => setFontSize(size => size + 2)}>+</button>
      <button className={BTN_SECONDARY} type="button" disabled={!unit} aria-pressed={unit && bookmarks.some(b => sameUnit(b.locator, unit.locator))} onClick={() => void bookmark()}>Bookmark</button>
    </div>
    <p className="shrink-0 px-4 py-2 text-xs text-ink-soft" role="status" aria-live="polite">{busy ? "Opening document…" : notice || record?.title || "Choose a PDF, EPUB, TXT or Markdown file. Files stay on this device."}</p>
    {error && <div className="mx-4 rounded-lg border border-danger/40 bg-danger/10 p-3 text-danger" role="alert">{error}</div>}
    {locked && <form className="flex gap-2 p-4" onSubmit={e => { e.preventDefault(); void openFile(locked, pendingRecord, password); }}>
      <label htmlFor="reader-password">PDF password</label><input id="reader-password" type="password" value={password} onChange={e => setPassword(e.target.value)} className="rounded border border-ink-soft px-2" />
      <button type="submit" className={BTN_PRIMARY}>Open</button>
    </form>}
    <div ref={viewport} className="min-h-0 flex-1 overflow-auto p-4 sm:p-6" aria-label="Document pages" onScroll={() => {
      if (mode !== "scroll" || !viewport.current) return;
      const top = viewport.current.getBoundingClientRect().top;
      // ponytail: linear page-box scan; virtualize the slots if books with thousands of pages need it.
      for (const [index, element] of pages.current) {
        const rect = element.getBoundingClientRect();
        if (rect.bottom > top + 24 && rect.top <= top + viewport.current.clientHeight) { setPage(index); break; }
      }
    }}>
      {reader && !unit && !error && mode === "single" && <p role="status" className="text-ink-soft">Extracting text…</p>}
      {mode === "single" ? unit && <div data-page={page}>{article(unit, page)}</div> : reader && <div className="space-y-6">
        {Array.from({ length: reader.count }, (_, index) => <div key={index} data-page={index} ref={element => { if (element) pages.current.set(index, element); else pages.current.delete(index); }}
          style={parsedUnits.has(index) ? undefined : { minHeight: heights.current.get(index) ?? 600 }}>
          {parsedUnits.get(index) ? article(parsedUnits.get(index)!, index) : <div className="mx-auto flex h-full min-h-80 max-w-3xl items-center justify-center rounded-xl border border-line bg-paper p-6 text-ink-soft" aria-hidden={!nearby.includes(index)} aria-label={`Page ${index + 1} loading`}>Page {index + 1} · {nearby.includes(index) ? "Parsing text…" : "Text loads as you scroll"}</div>}
        </div>)}
      </div>}
    </div>
    {(bookmarks.length > 0 || marks.length > 0) && <aside className="max-h-36 shrink-0 overflow-auto border-t border-line bg-paper p-3">
      <nav aria-label="Bookmarks" className="flex flex-wrap gap-2">{bookmarks.map(b => <button key={b.id} className={BTN_SM} type="button" onClick={() => navigate(reader?.indexOf(b.locator) ?? 0)}>{b.label}</button>)}</nav>
      <nav aria-label="Highlights" className="flex flex-wrap gap-2">{marks.map(m => <div key={m.id} className="flex items-center gap-1">
        <button className={`${BTN_SM} ${SWATCH[m.color]} max-w-64 text-ink`} type="button" onClick={() => { navigate(reader?.indexOf(m.anchor.locator) ?? 0); setJump(m); }} aria-label={`Jump to highlight: ${m.anchor.quote}`}><span className="truncate">{m.anchor.quote}</span></button>
        <button className={BTN_SM} type="button" aria-label={`Remove highlight: ${m.anchor.quote}`} onClick={() => void removeMark(m)}>×</button>
      </div>)}</nav>
    </aside>}
    <SelectionPopover state={popover} onStateChange={setPopover} lookupSurface={lookupSurface} store={db} onDismiss={() => setPopover(current => dismissPopover(current))} packAttribution={packAttribution} dictLoading={dictLoading} {...(ai ? { ai } : {})} {...(localProgress ? { localProgress } : {})}
      highlightActions={<div className="flex gap-2" aria-label="Highlight colors">{(Object.keys(SWATCH) as Mark["color"][]).map(color => <button key={color} type="button" className={`${BTN_ICON} ${SWATCH[color]} border border-line text-ink`} aria-label={`Highlight ${color}`} onClick={() => void addMark(color)} />)}</div>} />
  </section>;
}
