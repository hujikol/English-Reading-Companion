/**
 * The PDF reader screen.
 *
 * Every behaviour here is delegated to a module that already owns the policy:
 *  - `validate.ts`     the trust boundary for a picked file (Section 5)
 *  - `identity.ts`     documentId immediately, SHA-256 in the background
 *  - `windowing.ts`    what stays mounted, rendered, released and cancelled
 *  - `anchor.ts`       the durable Anchor for a live selection (Section 7)
 *  - `marks/save.ts`   the durable Mark row, geometry-free by construction
 *  - `progress.ts`     debounced progress writes with a revision guard
 *  - `bookmarks.ts`    named positions, save outcomes, announcement text
 *
 * The hard constraints are structural, not conventional:
 *  - rendering starts as soon as the file validates, never waiting for hashing
 *  - nothing persisted contains geometry; `pageFraction` is a scroll fraction
 *  - the canvas is sized by the windowing policy, so zoom cannot allocate an
 *    unbounded canvas
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Bookmark, Locator, Mark } from "../contracts/index.ts";
import { newDocumentId, sha256 } from "../features/library/identity.ts";
import { announce, hasBookmarkAt, isSamePosition, makeBookmark, saveBookmark, softDelete, visibleBookmarks } from "../features/library/bookmarks.ts";
import { MOVEMENT_DEBOUNCE_MS, initialProgressState, mustFlushNow, persistProgress, queueProgress, type ProgressState } from "../features/library/progress.ts";
import type { DeviceTier } from "../features/library/validate.ts";
import { validatePdfImport, type ImportError, type ImportNotice } from "../features/library/validate.ts";
import { PdfPasswordRequiredError, damagedErrorMessage, passwordErrorMessage } from "../features/reader/pdf/adapter.ts";
import type { MountedPage } from "../features/reader/pdf/windowing.ts";
import { PdfPage } from "../ui/reader/PdfPage.tsx";
import { pdfjsAdapter, type PdfjsDocumentHandle, type PdfjsPageHandle } from "../ui/reader/pdfEngine.ts";
import {
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
  clampZoom,
  locatorAt,
  locatorToPage,
  pageFractionAt,
  planFor,
  progressionAt,
  scrollTopFor,
  stepPage,
  visiblePageOf,
  type ScrollState,
  stackState,
  visiblePageOfState,
  pageFractionAtState,
} from "../ui/reader/readerModel.ts";
import { anchorFromSelection, pageOfNode, readSelection, type SelectionCapture } from "../ui/reader/selection.ts";
import { buildSelection } from "../ui/reader/popoverBridge.ts";
import { SelectionPopover } from "../ui/SelectionPopover.tsx";
import { lookupSurface } from "../ui/vocab/dictionaryLookup.ts";
import { dismissPopover, initialPopoverState, openPopover, type PopoverState } from "../ui/vocab/selectionPopover.ts";
import { trackFStore } from "../features/vocabulary/store.ts";
import { dbProgressStore, newMarkId, readBookmarks, readMarks, recordDocument, storeMark, touchDocument, writeBookmark } from "../ui/reader/stores.ts";
import "../ui/reader/reader.css";

/** Must match .reader__viewport in reader.css: gap and padding between pages. */
const STACK_GAP = 16;
const STACK_PADDING = 16;

/** Same-origin only: a reader has no reason to accept a remote document. */
const ACCEPTED_MIME = "application/pdf,.pdf";
const MARK_COLORS = ["yellow", "green", "blue", "pink"] as const;

type Status = "empty" | "validating" | "opening" | "ready" | "failed";

type OpenState = {
  documentId: string;
  title: string;
  originalName: string;
  document: PdfjsDocumentHandle;
  /** filled in when the background hash lands; rendering never waits for it */
  contentHash?: string;
  identityState: "hashing" | "ready";
  /** restored position, applied once the pages have real heights */
  restored: { page: number; fraction: number };
};

export type ReaderScreenProps = {
  /**
   * A document to open from outside the reader (the library). Applied as an
   * effect rather than a prop watch so handing over the same File twice does not
   * reopen it twice.
   */
  pendingDocument?: File | undefined;
  onDocumentOpened?: (documentId: string) => void;
};

export function ReaderScreen({ pendingDocument, onDocumentOpened }: ReaderScreenProps = {}) {
  const [status, setStatus] = useState<Status>("empty");
  const [errors, setErrors] = useState<ImportError[]>([]);
  const [notices, setNotices] = useState<ImportNotice[]>([]);
  const [open, setOpen] = useState<OpenState | undefined>(undefined);
  /** the file waiting for a password, kept in memory only */
  const [lockedFile, setLockedFile] = useState<File | undefined>(undefined);
  const [password, setPassword] = useState("");

  // reader view state
  const [visiblePage, setVisiblePage] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [mounted, setMounted] = useState<Map<number, MountedPage>>(new Map());
  const [inflight, setInflight] = useState<number[]>([]);
  const [selectionPage, setSelectionPage] = useState<number | undefined>(undefined);
  const [tabVisible, setTabVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  const [pageText, setPageText] = useState<Map<number, string>>(new Map());
  const [marks, setMarks] = useState<Mark[]>([]);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [progressLabel, setProgressLabel] = useState("");
  const [live, setLive] = useState("");
  const [pendingBookmark, setPendingBookmark] = useState<{ draft: Bookmark; error: string } | undefined>(undefined);
  const [selection, setSelection] = useState<{ capture: SelectionCapture; pageIndex: number } | undefined>(undefined);
  /** the real page box at scale 1; the policy multiplies this by zoom */
  const [baseSize, setBaseSize] = useState({ widthCss: 612, heightCss: 792 });

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const pageRefs = useRef(new Map<number, HTMLDivElement>());
  const textLayers = useRef(new Map<HTMLElement, number>());
  const cancels = useRef(new Map<number, () => void>());
  const pageHandles = useRef(new Map<number, PdfjsPageHandle>());
  const lastWritten = useRef<Locator | undefined>(undefined);
  const pendingPosition = useRef<{ locator: Locator; progression: number } | undefined>(undefined);
  const debounceTimer = useRef<number | undefined>(undefined);
  const restoredRef = useRef(false);
  const goToPageRef = useRef<(page: number) => Promise<void>>(() => Promise.resolve());
  /**
   * The progress state is held in a ref, not in React state, and only its label
   * is rendered. If the state object were a dep of `flushProgress`, every write
   * would build a new closure, re-run the effect that drives it, and arm the
   * debounce again: a render loop that would never settle.
   */
  const progressRef = useRef<ProgressState | undefined>(undefined);

  const pageCount = open?.document.capabilities.pageCount ?? 0;
  const tier: DeviceTier = useMemo(() => (typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches ? "phone" : "desktop"), []);


  const plan = useMemo(
    () =>
      planFor({
        visiblePage,
        pageCount,
        tier,
        mounted: [...mounted.values()],
        viewport: baseSize,
        zoom,
        devicePixelRatio: typeof window === "undefined" ? 1 : window.devicePixelRatio,
        inflight,
        tabVisible,
        ...(selectionPage === undefined ? {} : { selectionPage }),
      }),
    [visiblePage, pageCount, tier, mounted, baseSize, zoom, inflight, tabVisible, selectionPage],
  );

  /**
   * Page tops and heights in CSS px.
   *
   * Derived from the stack layout, not measured per page: only MOUNTED pages
   * have a DOM box, so measuring could never see past the render window — the
   * reader could not scroll beyond it, which read as blank space with page tops
   * jumping as pages mounted and unmounted.
   */
  const scrollState = useCallback((): ScrollState => {
    const viewport = viewportRef.current;
    if (viewport === null || pageCount === 0) return { scrollTop: 0, heights: new Map(), tops: new Map() };
    return stackState(
      { pageCount, pageHeight: plan.cssSize.heightCss, gap: STACK_GAP, padding: STACK_PADDING },
      viewport.scrollTop,
    );
  }, [pageCount, plan.cssSize.heightCss]);

  // Cancel what the policy marked superseded (hidden tab, or scrolled away).
  useEffect(() => {
    for (const page of plan.cancel) cancels.current.get(page)?.();
  }, [plan.cancel]);

  // Keep the visible page in sync with the scroll position.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null) return undefined;
    let frame = 0;
    const onScroll = () => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const page = visiblePageOfState(scrollState());
        setVisiblePage((current) => (current === page ? current : page));
      });
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      viewport.removeEventListener("scroll", onScroll);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [scrollState]);

  // Section 6: speculative work pauses when the tab is hidden.
  useEffect(() => {
    const onVisibility = () => setTabVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // ---- opening a document -------------------------------------------------

  const openFile = useCallback(
    async (file: File, suppliedPassword?: string) => {
      setStatus("validating");
      setErrors([]);
      setNotices([]);

      const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
      const validation = validatePdfImport({ name: file.name, mimeType: file.type, byteSize: file.size, tier, head });
      if (!validation.ok) {
        setErrors(validation.errors);
        setStatus("failed");
        return;
      }
      setNotices(validation.notices);

      setStatus("opening");
      const bytes = new Uint8Array(await file.arrayBuffer());
      // Section 5: a random stable id is assigned immediately; the content hash
      // is computed in the background and never blocks display.
      const documentId = newDocumentId();

      let pdf: PdfjsDocumentHandle;
      try {
        pdf = await pdfjsAdapter.open(bytes, suppliedPassword);
      } catch (e) {
        if (e instanceof PdfPasswordRequiredError) {
          // Render-only operation stays available once the password is supplied;
          // the password itself never leaves this function's scope.
          setLockedFile(file);
          setErrors([{ code: "encrypted", message: passwordErrorMessage, action: "Enter it below to open the document." }]);
          setStatus("failed");
          return;
        }
        setErrors([{ code: "damaged", message: damagedErrorMessage, action: e instanceof Error ? e.message : "The file could not be opened." }]);
        setStatus("failed");
        return;
      }
      setLockedFile(undefined);
      setPassword("");

      // Seed the policy's viewport base from the real page box, so the page
      // keeps its aspect ratio at any zoom instead of being stretched to a
      // guessed size.
      try {
        const first = await pdf.page(0);
        pageHandles.current.set(0, first);
        setBaseSize({ widthCss: first.size.width, heightCss: first.size.height });
      } catch {
        setBaseSize({ widthCss: 612, heightCss: 792 });
      }

      const restoredRow = await dbProgressStore.read(documentId);
      setOpen({
        documentId,
        title: file.name.replace(/\.pdf$/i, ""),
        originalName: file.name,
        document: pdf,
        identityState: "hashing",
        restored: locatorToPage(restoredRow?.locator),
      });
      progressRef.current = initialProgressState(documentId, restoredRow);
      setProgressLabel("");
      lastWritten.current = restoredRow?.locator;
      pendingPosition.current = undefined;
      setVisiblePage(locatorToPage(restoredRow?.locator).page);
      setZoom(1);
      setMounted(new Map());
      setPageText(new Map());
      setSelection(undefined);
      setSelectionPage(undefined);
      restoredRef.current = false;
      setStatus("ready");
      void touchDocument(documentId).catch(() => undefined);

      // Background identity + durability. Deliberately not awaited above: the
      // first page is already rendering while this runs.
      void (async () => {
        try {
          const contentHash = await sha256(bytes);
          setOpen((current) => (current?.documentId === documentId ? { ...current, contentHash, identityState: "ready" } : current));
          await recordDocument({
            id: documentId,
            title: file.name.replace(/\.pdf$/i, ""),
            originalName: file.name,
            byteSize: file.size,
            pageCount: pdf.capabilities.pageCount,
            contentHash,
            asset: { documentId, blob: file, mime: "application/pdf", byteSize: file.size, checksum: contentHash },
          });
        } catch {
          // The document stays open in this session; only durability failed,
          // and the UI keeps saying so rather than claiming it is saved.
        }
      })();
    },
    [tier],
  );
  // A document handed over by the library. A ref guard, not a dependency on the
  // File identity: the library may hand the same File twice and reopening on
  // every parent render would fight the learner's place in the book.
  const openedExternal = useRef<File | undefined>(undefined);
  useEffect(() => {
    if (pendingDocument === undefined) return;
    if (openedExternal.current === pendingDocument) return;
    openedExternal.current = pendingDocument;
    void openFile(pendingDocument, "");
  }, [pendingDocument]);

  // Load marks and bookmarks for the open document.
  const documentId = open?.documentId;
  useEffect(() => {
    if (documentId === undefined) return;
    void (async () => {
      setMarks(await readMarks(documentId));
      setBookmarks(await readBookmarks(documentId));
    })();
  }, [documentId, open?.identityState]);

  // Restore the saved scroll position once the first page has a real height.
  useEffect(() => {
    if (open === undefined || status !== "ready" || restoredRef.current) return;
    if (pageRefs.current.size === 0) return;
    restoredRef.current = true;
    const target = scrollTopFor(open.restored.page, open.restored.fraction, scrollState());
    const viewport = viewportRef.current;
    if (viewport !== null && target > 0) viewport.scrollTop = target;
  }, [open, status, mounted, scrollState]);

  // ---- progress -----------------------------------------------------------

  const flushProgress = useCallback(
    async (reason: "move" | "page-change" | "visibility-change" | "close") => {
      if (open === undefined) return;
      const pending = pendingPosition.current;
      if (pending === undefined) return;
      const flushNow = mustFlushNow(lastWritten.current, pending.locator, reason);

      if (!flushNow) {
        // Movement inside one page: coalesce into one write per window. Until it
        // resolves the position is "outstanding", never Saved (Section 13).
        const current = progressRef.current;
        if (current !== undefined) progressRef.current = queueProgress(current, pending.locator, pending.progression);
        setProgressLabel("saving position…");
        if (debounceTimer.current !== undefined) window.clearTimeout(debounceTimer.current);
        debounceTimer.current = window.setTimeout(() => {
          debounceTimer.current = undefined;
          void flushProgress("page-change");
        }, MOVEMENT_DEBOUNCE_MS);
        return;
      }

      pendingPosition.current = undefined;
      if (debounceTimer.current !== undefined) {
        window.clearTimeout(debounceTimer.current);
        debounceTimer.current = undefined;
      }
      const state = progressRef.current ?? initialProgressState(open.documentId);
      const { state: next, outcome } = await persistProgress(state, pending, dbProgressStore);
      lastWritten.current = next.lastWritten;
      progressRef.current = next;
      const page = pending.locator.kind === "pdf" ? pending.locator.pageIndex + 1 : 1;
      setProgressLabel(outcome.kind === "saved" ? "position saved" : outcome.kind === "conflict" ? "position not saved: another tab is ahead" : "position not saved");
      setLive(
        outcome.kind === "saved"
          ? `Position saved: page ${page}`
          : outcome.kind === "conflict"
            ? "Position not saved: another tab saved a newer location."
            : `Position not saved: ${outcome.message}`,
      );
    },
    [open],
  );

  // A position change: page boundary flushes at once, scroll is debounced.
  useEffect(() => {
    if (open === undefined || pageCount === 0) return;
    const state = scrollState();
    pendingPosition.current = { locator: locatorAt(visiblePage, pageFractionAtState(state, visiblePage)), progression: progressionAt(state, pageCount) };
    void flushProgress(lastWritten.current === undefined ? "page-change" : "move");
  }, [visiblePage, zoom, pageCount, open, mounted, scrollState, flushProgress]);

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") void flushProgress("visibility-change");
    };
    const onPageHide = () => void flushProgress("close");
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onPageHide);
      void flushProgress("close");
    };
  }, [flushProgress]);

  // ---- page handles -------------------------------------------------------

  const getPage = useCallback(
    async (pageIndex: number): Promise<PdfjsPageHandle> => {
      if (open === undefined) throw new Error("No document is open.");
      const cached = pageHandles.current.get(pageIndex);
      if (cached !== undefined) return cached;
      const handle = (await open.document.page(pageIndex)) as PdfjsPageHandle;
      pageHandles.current.set(pageIndex, handle);
      setInflight((current) => (current.includes(pageIndex) ? current : [...current, pageIndex]));
      return handle;
    },
    [open],
  );

  const reportPixelSize = useCallback((pageIndex: number, widthPx: number, heightPx: number) => {
    setMounted((current) => {
      const existing = current.get(pageIndex);
      if (existing !== undefined && existing.widthPx === widthPx && existing.heightPx === heightPx) return current;
      const next = new Map(current);
      next.set(pageIndex, { pageIndex, widthPx, heightPx });
      return next;
    });
  }, []);

  const onTextLayerReady = useCallback((pageIndex: number, element: HTMLElement) => {
    textLayers.current.set(element, pageIndex);
    void (async () => {
      const handle = pageHandles.current.get(pageIndex);
      if (handle === undefined) return;
      const text = await handle.text();
      setPageText((current) => {
        if (current.get(pageIndex) === text) return current;
        const next = new Map(current);
        next.set(pageIndex, text);
        return next;
      });
      setInflight((current) => current.filter((p) => p !== pageIndex));
    })();
  }, []);

  const registerPageBox = useCallback((pageIndex: number, element: HTMLDivElement | null) => {
    if (element === null) pageRefs.current.delete(pageIndex);
    else pageRefs.current.set(pageIndex, element);
  }, []);

  const onRelease = useCallback((pageIndex: number) => {
    textLayers.current.forEach((page, element) => {
      if (page === pageIndex) textLayers.current.delete(element);
    });
    pageHandles.current.delete(pageIndex);
    setMounted((current) => {
      if (!current.has(pageIndex)) return current;
      const next = new Map(current);
      next.delete(pageIndex);
      return next;
    });
    setInflight((current) => current.filter((p) => p !== pageIndex));
  }, []);

  // ---- navigation ---------------------------------------------------------

  const goToPage = useCallback(
    async (page: number) => {
      setVisiblePage(page);
      // Let the target page mount before scrolling to it.
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const top = scrollState().tops.get(page);
      const viewport = viewportRef.current;
      if (top !== undefined && viewport !== null) viewport.scrollTop = top;
      void flushProgress("page-change");
    },
    [scrollState, flushProgress],
  );
  goToPageRef.current = goToPage;

  // ---- selection ----------------------------------------------------------

  const captureSelection = useCallback(() => {
    const current = window.getSelection();
    if (current === null || current.isCollapsed || current.rangeCount === 0) {
      setSelection(undefined);
      setSelectionPage(undefined);
      return;
    }
    const node = current.getRangeAt(0).startContainer;
    const pageIndex = pageOfNode(node, textLayers.current);
    if (pageIndex === undefined) return; // a selection outside a text layer: leave the last one alone
    const element = [...textLayers.current].find(([, page]) => page === pageIndex)?.[0];
    if (element === undefined) return;
    const capture = readSelection(element);
    if (capture === undefined) return;
    setSelection({ capture, pageIndex });
    setSelectionPage(pageIndex);
  }, []);

  const currentLocator = useMemo((): Locator => locatorAt(visiblePage, pageFractionAtState(scrollState(), visiblePage)), [visiblePage, mounted, scrollState]);
  const bookmarkedHere = useMemo(() => hasBookmarkAt(bookmarks, currentLocator), [bookmarks, currentLocator]);

  // ---- bookmarks ----------------------------------------------------------

  const addBookmark = useCallback(async () => {
    if (open === undefined) return;
    const draft = makeBookmark({ documentId: open.documentId, titleSnapshot: open.title, locator: currentLocator });
    const outcome = await saveBookmark(draft, writeBookmark);
    if (outcome.kind === "saved") {
      setBookmarks((current) => [...current, outcome.bookmark]);
      setPendingBookmark(undefined);
    } else {
      // Section 4: a failed write keeps the entry visible and editable to retry.
      setPendingBookmark({ draft: outcome.draft, error: outcome.message });
    }
    // Announced, not just drawn: a transient badge is not announced.
    setLive(announce(outcome));
  }, [open, currentLocator]);

  const removeBookmark = useCallback(
    async (bookmark: Bookmark) => {
      await writeBookmark(softDelete(bookmark));
      setBookmarks((current) => current.filter((b) => b.id !== bookmark.id));
      setLive(`Bookmark removed: ${bookmark.label}`);
    },
    [],
  );

  const toggleBookmark = useCallback(() => {
    const existing = bookmarks.find((b) => isSamePosition(b.locator, currentLocator));
    if (existing !== undefined) void removeBookmark(existing);
    else void addBookmark();
  }, [bookmarks, currentLocator, addBookmark, removeBookmark]);

  // Keyboard reachable: "b" toggles the bookmark at the current position,
  // PageUp/PageDown page through, Escape dismisses the selection surface.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target !== null && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "b") {
        event.preventDefault();
        toggleBookmark();
      } else if (event.key === "PageDown") {
        event.preventDefault();
        void goToPageRef.current(stepPage(visiblePage, 1, pageCount));
      } else if (event.key === "PageUp") {
        event.preventDefault();
        void goToPageRef.current(stepPage(visiblePage, -1, pageCount));
      } else if (event.key === "Escape") {
        setSelection(undefined);
        setSelectionPage(undefined);
        window.getSelection()?.removeAllRanges();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleBookmark, visiblePage, pageCount]);

  // ---- marks --------------------------------------------------------------

  const addMark = useCallback(
    async (color: Mark["color"]) => {
      if (open === undefined || selection === undefined) return;
      const text = pageText.get(selection.pageIndex);
      if (text === undefined) {
        // The text layer is still being read; the anchor needs real page text.
        setLive("Still reading this page's text. Try again in a moment.");
        return;
      }
      const anchor = anchorFromSelection(selection.capture, {
        pageIndex: selection.pageIndex,
        pageFraction: pageFractionAtState(scrollState(), selection.pageIndex),
        pageText: text,
        now: Date.now(),
      });
      const stored = await storeMark({
        id: newMarkId(),
        documentId: open.documentId,
        titleSnapshot: open.title,
        quote: anchor.quote,
        ...(anchor.prefix === undefined ? {} : { prefix: anchor.prefix }),
        ...(anchor.suffix === undefined ? {} : { suffix: anchor.suffix }),
        locator: anchor.locator,
        color,
        now: Date.now(),
      });
      if (stored === undefined) {
        setLive("Mark could not be saved.");
        return;
      }
      setMarks((current) => [...current, stored]);
      setLive(`Marked: ${stored.anchor.quote.slice(0, 40)}`);
    },
    [open, selection, pageText, scrollState],
  );

  // ---- lookup popover -----------------------------------------------------
  // The reader captured selections but nothing ever opened the lookup card, so
  // selecting a word produced no lookup at all. This is that join: capture ->
  // bridge -> popover, and the real local dictionary behind it.

  const [popover, setPopover] = useState<PopoverState>(initialPopoverState);

  const popoverSelection = useMemo(() => {
    if (!open || !selection) return undefined;
    const text = pageText.get(selection.pageIndex);
    // No page text means no prefix/suffix context and no sentence, so the
    // anchor would be weak. Wait for the text rather than saving a bad anchor.
    if (text === undefined) return undefined;
    return buildSelection({
      capture: selection.capture,
      pageIndex: selection.pageIndex,
      pageFraction: 0,
      pageText: text,
      documentId: open.documentId,
      titleSnapshot: open.title,
    });
  }, [open, selection, pageText]);

  useEffect(() => {
    if (popoverSelection === undefined) return;
    setPopover((current) => (current.open && current.selection?.surface === popoverSelection.surface ? current : openPopover(current, popoverSelection)));
  }, [popoverSelection]);

  const closePopover = useCallback(() => setPopover((current) => dismissPopover(current)), []);


  // ---- render -------------------------------------------------------------

  const shownBookmarks = visibleBookmarks(bookmarks);

  return (
    <div className="reader" onMouseUp={captureSelection}>
      <div className="reader__bar">
        <label className="reader__button" htmlFor="reader-open">
          Open PDF…
        </label>
        <input
          id="reader-open"
          type="file"
          accept={ACCEPTED_MIME}
          className="reader__visually-hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file !== undefined) void openFile(file);
          }}
        />

        <div className="reader__toolbar" role="group" aria-label="Page navigation">
          <button type="button" onClick={() => void goToPage(stepPage(visiblePage, -1, pageCount))} disabled={pageCount === 0 || visiblePage <= 0} aria-label="Previous page">
            ‹ Prev
          </button>
          <span>
            Page {pageCount === 0 ? "–" : visiblePage + 1} of {pageCount === 0 ? "–" : pageCount}
          </span>
          <button
            type="button"
            onClick={() => void goToPage(stepPage(visiblePage, 1, pageCount))}
            disabled={pageCount === 0 || visiblePage >= pageCount - 1}
            aria-label="Next page"
          >
            Next ›
          </button>
        </div>

        <div className="reader__toolbar" role="group" aria-label="Zoom">
          <button type="button" onClick={() => setZoom((z) => clampZoom(z - ZOOM_STEP))} disabled={zoom <= ZOOM_MIN} aria-label="Zoom out">
            −
          </button>
          <span>{Math.round(zoom * 100)}%</span>
          <button type="button" onClick={() => setZoom((z) => clampZoom(z + ZOOM_STEP))} disabled={zoom >= ZOOM_MAX} aria-label="Zoom in">
            +
          </button>
        </div>

        <button
          type="button"
          aria-pressed={bookmarkedHere}
          aria-keyshortcuts="b"
          onClick={toggleBookmark}
          disabled={open === undefined}
          aria-label={`Bookmark this position${bookmarkedHere ? ", bookmarked" : ""}`}
        >
          ⚑ {bookmarkedHere ? "Bookmarked" : "Bookmark"}
        </button>

        <span className="reader__status">
          {status === "validating" || status === "opening" ? "opening…" : null}
          {open === undefined
            ? ""
            : ` · ${open.identityState === "hashing" ? "hashing…" : "saved locally"} · ${progressLabel} · ${plan.keep.length} pages mounted · canvas ${plan.pxSize.width}×${plan.pxSize.height} @${plan.scale}×`}
        </span>
      </div>

      <div className="reader__viewport" ref={viewportRef} tabIndex={0} aria-label="Document pages">
        {status === "empty" ? <p className="reader__empty">Choose a PDF to read. The file stays on this device.</p> : null}

        {status === "failed" ? (
          <div className="reader__error" role="alert">
            <h2>This file could not be opened</h2>
            {errors.map((error) => (
              <p key={`${error.code}-${error.message}`}>
                <strong>{error.message}</strong> {error.action}
              </p>
            ))}
            {notices.map((notice) => (
              <p key={`notice-${notice.code}-${notice.message}`}>
                {notice.message} {notice.action}
              </p>
            ))}
            {lockedFile === undefined ? null : (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void openFile(lockedFile, password);
                }}
              >
                <label htmlFor="reader-password">PDF password</label>{" "}
                <input
                  id="reader-password"
                  type="password"
                  value={password}
                  autoComplete="off"
                  onChange={(event) => setPassword(event.target.value)}
                />{" "}
                <button type="submit">Open</button>
              </form>
            )}
          </div>
        ) : null}

        {open === undefined
                  ? null
                  : // Every page gets a slot. Pages outside the render window render as
                    // a spacer of the same height, so the scroll height is the real
                    // document height and scrolling is continuous instead of collapsing
                    // as pages unmount.
                    Array.from({ length: pageCount }, (_, pageIndex) => {
                      const mounted = plan.keep.includes(pageIndex);
                      if (!mounted) {
                        return (
                          <div
                            key={pageIndex}
                            className="reader__spacer"
                            aria-hidden="true"
                            data-page={pageIndex}
                            style={{ height: plan.cssSize.heightCss }}
                          />
                        );
                      }
                      return (
                        <PdfPage
                          key={pageIndex}
                          pageIndex={pageIndex}
                          widthCss={plan.cssSize.widthCss}
                          heightCss={plan.cssSize.heightCss}
                          scale={plan.scale}
                          getPage={getPage}
                          marks={marks}
                          pageText={pageText.get(pageIndex)}
                          registerCancel={(index, cancel) => {
                            if (cancel === undefined) cancels.current.delete(index);
                            else cancels.current.set(index, cancel);
                          }}
                          registerPageBox={registerPageBox}
                          reportPixelSize={reportPixelSize}
                          onTextLayerReady={onTextLayerReady}
                          onRelease={onRelease}
                        />
                      );
                    })}
      </div>

      {shownBookmarks.length > 0 || pendingBookmark !== undefined ? (
        <nav className="reader__bookmarks" aria-label="Bookmarks">
          <ul>
            {shownBookmarks.map((bookmark) => (
              <li key={bookmark.id}>
                <button type="button" className="reader__jump" onClick={() => void goToPage(bookmark.locator.kind === "pdf" ? bookmark.locator.pageIndex : visiblePage)}>
                  {bookmark.label}
                </button>
                <button type="button" className="reader__delete" onClick={() => void removeBookmark(bookmark)} aria-label={`Delete bookmark ${bookmark.label}`}>
                  ✕
                </button>
              </li>
            ))}
            {pendingBookmark === undefined ? null : (
              <li>
                <span className="reader__jump reader__unsaved">
                  {pendingBookmark.draft.label} — not saved: {pendingBookmark.error}
                </span>
              </li>
            )}
          </ul>
        </nav>
      ) : null}

      {selection === undefined ? null : (
        <div
          className="reader__popover"
          role="group"
          aria-label="Selection actions"
          style={{
            top: Math.max(8, (selection.capture.viewportRect?.top ?? 80) - 56),
            left: Math.max(8, selection.capture.viewportRect?.left ?? 8),
          }}
        >
          <p>{selection.capture.quote.slice(0, 60)}</p>
          {MARK_COLORS.map((color) => (
            <button key={color} type="button" onClick={() => void addMark(color)} aria-label={`Mark selection ${color}`}>
              {color.charAt(0).toUpperCase()}
            </button>
          ))}
        </div>
      )}

      {/* The lookup card. This is the product: select a word, learn it. */}
      <SelectionPopover
        state={popover}
        onStateChange={setPopover}
        lookupSurface={lookupSurface}
        store={trackFStore}
        onDismiss={closePopover}
        packAttribution={null}
      />

      {/* Live region: bookmark and mark outcomes are announced, not just drawn. */}
      <div className="reader__visually-hidden" role="status" aria-live="polite">
        {live}
      </div>
    </div>
  );
}
