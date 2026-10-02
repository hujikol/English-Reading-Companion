/**
 * The EPUB reading surface.
 *
 * Mountable as-is: it brings its own file input, or accepts bytes from a host
 * that already has them (import, library row, "reopen where I left off"). It
 * renders chapters in a sandboxed iframe and turns a selection into the same
 * `Anchor` the PDF reader produces, so marks, bookmarks and occurrences work
 * across formats without a second code path.
 *
 * What this component deliberately does NOT do: persist anything. It hands the
 * Anchor and the Locator to `onAnchor` / `onLocator` and leaves the writes to
 * the shell that owns the database. A reader surface that quietly wrote rows
 * would make "did this save?" unanswerable from the UI.
 *
 * It also never falls back to a blank page: a chapter that cannot be rendered
 * says why, in place, and the reader keeps its place in the book.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Anchor, Locator } from "../contracts/index.ts";
import { EpubChapterFrame, EpubRenderer, readFrameSelection, type RenderedChapter } from "../features/reader/epub/renderer.tsx";
import {
  anchorFromFrameSelection,
  chapterPosition,
  progressionOf,
  restorePosition,
  stepPosition,
} from "../features/reader/epub/reader.tsx";
import type { Appearance, OpenFailure } from "../features/reader/epub/adapter.ts";
import "../ui/reader/reader.css";

const ACCEPTED_MIME = "application/epub+zip,.epub";
const FONT_STEP_PX = 2;
const FONT_MIN_PX = 12;
const FONT_MAX_PX = 32;

/** The frame fills the viewport column and scrolls itself; the host never
 *  measures it, because a measured frame is how geometry leaks into a locator. */
const FRAME_STYLE = {
  width: "100%",
  flex: "1 1 auto",
  minHeight: "60vh",
  border: "none",
  borderRadius: "8px",
  background: "#ffffff",
} as const;

type Open =
  | { status: "ready"; renderer: EpubRenderer; title: string; hrefCount: number }
  | { status: "failed"; message: string; detail: string };

/** Why a book could not be opened, in the reader's voice (s8: report, never half-render). */
export function openFailureMessage(failure: OpenFailure): string {
  if (failure.reason !== "unsupported") return "This file could not be opened as an EPUB.";
  switch (failure.unsupported.kind) {
    case "drm":
      return "This book is DRM-protected, so its text cannot be read here.";
    case "encrypted":
      return "This book is encrypted, so its text cannot be read here.";
    case "fixed-layout":
      return "This is a fixed-layout book. Only reflowable text books can be read in this version.";
    case "oversized":
      return failure.detail.includes("expansion")
        ? "This book is compressed in a way that indicates a decompression bomb, so it was not opened."
        : "This book is too large to open safely on this device.";
    case "zip":
      return "This book's archive contains unsafe file paths, so it was not opened.";
    case "needs-encoding":
      return "This chapter's text is not in a readable encoding.";
    default:
      return "This file could not be opened as an EPUB.";
  }
}

export type EpubScreenProps = {
  /** Open these bytes instead of showing a file input. */
  bytes?: Uint8Array;
  fileName?: string;
  /** Where to resume, if the host has a stored locator. */
  initialLocator?: Locator;
  appearance?: Partial<Appearance>;
  /** Fired for every selection, with the durable Anchor. */
  onAnchor?: (anchor: Anchor) => void;
  /** Fired when the reading position changes, with a geometry-free Locator. */
  onLocator?: (locator: Locator, progression: number) => void;
  /** Fired once the book is open, with the renderer's documentId. */
  onOpened?: (documentId: string) => void;
};

export function EpubScreen(props: EpubScreenProps) {
  const [open, setOpen] = useState<Open | undefined>(undefined);
  const [position, setPosition] = useState(0);
  const [chapter, setChapter] = useState<RenderedChapter | undefined>(undefined);
  const [anchor, setAnchor] = useState<Anchor | undefined>(undefined);
  const [live, setLive] = useState("");
  const [fontSizePx, setFontSizePx] = useState(props.appearance?.fontSizePx ?? 18);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const rendererRef = useRef<EpubRenderer | undefined>(undefined);

  const baseAppearance = useMemo<Appearance>(
    () => ({
      fontFamily: props.appearance?.fontFamily ?? "Georgia, serif",
      fontSizePx,
      lineHeight: props.appearance?.lineHeight ?? 1.6,
      marginPx: props.appearance?.marginPx ?? 24,
      theme: props.appearance?.theme ?? "light",
    }),
    [props.appearance, fontSizePx],
  );

  const showAt = useCallback(
    (next: number) => {
      const renderer = rendererRef.current;
      if (renderer === undefined) return;
      const rendered = renderer.renderIndex(next);
      setPosition(next);
      setChapter(rendered);
      setAnchor(undefined);
      frameRef.current = null;
      if (rendered.ok) {
        setLive(rendered.chapter.title ?? `Section ${next + 1}`);
        props.onLocator?.({ kind: "epub", spineHref: rendered.chapter.spineHref }, progressionOf(renderer.book, next));
      } else {
        setLive("This section could not be displayed.");
      }
    },
    [props],
  );

  const openBytes = useCallback(
    async (bytes: Uint8Array, name: string) => {
      rendererRef.current?.close();
      rendererRef.current = undefined;
      setOpen(undefined);
      setAnchor(undefined);

      const renderer = new EpubRenderer();
      const result = await renderer.open(bytes);
      if (!result.ok) {
        renderer.close();
        const message = openFailureMessage(result);
        setOpen({ status: "failed", message, detail: result.detail });
        setLive(message);
        return;
      }
      rendererRef.current = renderer;
      renderer.setAppearance(baseAppearance);
      const book = renderer.book;
      setOpen({
        status: "ready",
        renderer,
        title: book?.title ?? name.replace(/\.epub$/i, ""),
        hrefCount: result.chapters.length,
      });
      props.onOpened?.(result.documentId);

      // Expensive indexing happens after the first chapter is on screen (s8).
      showAt(restorePosition(book, props.initialLocator) ?? 0);
      void renderer.index().then(() => setLive("Ready to search this book's text."));
    },
    [baseAppearance, props, showAt],
  );

  useEffect(() => {
    if (props.bytes === undefined) return;
    void openBytes(props.bytes, props.fileName ?? "book.epub");
    // Re-opening on a new byte array is the host's explicit request.
  }, [props.bytes, props.fileName, openBytes]);

  // Appearance changes re-render the current chapter so the new typography
  // reaches the frame; the reading position is untouched.
  useEffect(() => {
    const renderer = rendererRef.current;
    if (renderer === undefined || open?.status !== "ready") return;
    const rendered = renderer.rerenderCurrent();
    if (rendered !== undefined) setChapter(rendered);
  }, [baseAppearance, open?.status]);

  useEffect(() => () => rendererRef.current?.close(), []);

  const onSelect = useCallback(() => {
    const renderer = rendererRef.current;
    const selection = readFrameSelection(frameRef.current);
    if (renderer === undefined || selection === undefined || open?.status !== "ready") {
      setAnchor(undefined);
      return;
    }
    const frame = frameRef.current?.contentDocument?.body;
    const chapterText = frame?.textContent ?? (chapter?.ok === true ? chapter.text : "");
    const built = anchorFromFrameSelection({
      selection,
      spineHref: chapter?.ok === true ? chapter.chapter.spineHref : "",
      chapterText,
      now: Date.now(),
    });
    setAnchor(built);
    props.onAnchor?.(built);
    setLive(built.anchorState === "resolved" ? "Passage selected." : "Passage selected; it will be re-found by text later.");
  }, [chapter, open, props]);

  const info = chapterPosition(open?.status === "ready" ? open.renderer.book : undefined, position);
  const count = info?.count ?? 0;

  return (
    <div className="reader" onMouseUp={onSelect}>
      <div className="reader__bar">
        <label className="reader__button" htmlFor="epub-open">
          Open EPUB…
        </label>
        <input
          id="epub-open"
          type="file"
          accept={ACCEPTED_MIME}
          className="reader__visually-hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file === undefined) return;
            void file.arrayBuffer().then((buffer) => openBytes(new Uint8Array(buffer), file.name));
          }}
        />

        <div className="reader__toolbar" role="group" aria-label="Chapter navigation">
          <button
            type="button"
            onClick={() => showAt(stepPosition(position, -1, count))}
            disabled={open?.status !== "ready" || position <= 0}
            aria-label="Previous section"
          >
            ‹ Previous
          </button>
          <span>
            {info === undefined ? "No book open" : `Section ${info.position + 1} of ${info.count} — ${info.label}`}
          </span>
          <button
            type="button"
            onClick={() => showAt(stepPosition(position, 1, count))}
            disabled={open?.status !== "ready" || count === 0 || position >= count - 1}
            aria-label="Next section"
          >
            Next ›
          </button>
        </div>

        <div className="reader__toolbar" role="group" aria-label="Text size">
          <button type="button" onClick={() => setFontSizePx((px) => Math.max(FONT_MIN_PX, px - FONT_STEP_PX))} disabled={fontSizePx <= FONT_MIN_PX} aria-label="Smaller text">
            −
          </button>
          <span>{fontSizePx}px</span>
          <button type="button" onClick={() => setFontSizePx((px) => Math.min(FONT_MAX_PX, px + FONT_STEP_PX))} disabled={fontSizePx >= FONT_MAX_PX} aria-label="Larger text">
            +
          </button>
        </div>

        <span className="reader__status">
          {open === undefined ? "" : open.status === "ready" ? `${open.title} · ${open.hrefCount} sections · stays on this device` : open.status === "failed" ? "not opened" : "opening…"}
        </span>
      </div>

      <div className="reader__viewport" tabIndex={0} aria-label="Book text">
        {open === undefined ? <p className="reader__empty">Choose an EPUB to read. The file never leaves this device.</p> : null}

        {open?.status === "failed" ? (
          <div className="reader__error" role="alert">
            <h2>This book could not be opened</h2>
            <p>{open.message}</p>
            <p>{open.detail}</p>
          </div>
        ) : null}

        {chapter !== undefined && !chapter.ok ? (
          <div className="reader__error" role="alert">
            <h2>This section could not be displayed</h2>
            <p>{chapter.detail}</p>
            <p>Use Previous and Next to move to another section.</p>
          </div>
        ) : null}

        {chapter?.ok === true ? (
          <EpubChapterFrame
            frame={chapter.frame}
            title={`${chapter.chapter.title ?? "Section"} text`}
            className="epub-frame"
            style={FRAME_STYLE}
            onFrame={(element) => {
              frameRef.current = element;
            }}
          />
        ) : null}
      </div>

      {anchor === undefined ? null : (
        <div className="reader__popover" role="group" aria-label="Selected passage">
          <p>{anchor.quote.slice(0, 60)}</p>
          <span className="reader__visually-hidden">
            {anchor.locator.kind === "epub" ? anchor.locator.spineHref : ""}
          </span>
        </div>
      )}

      <div className="reader__visually-hidden" role="status" aria-live="polite">
        {live}
      </div>
    </div>
  );
}
