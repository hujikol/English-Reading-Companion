# PDF reader

Renders a real PDF with `pdfjs-dist`, captures real text selections, saves marks, tracks
progress and manages bookmarks.

## What is here

| File | Role |
|---|---|
| `pdfEngine.ts` | The only file that imports `pdfjs-dist`. Implements the `PdfAdapter` seam from `features/reader/pdf/adapter.ts`; the windowing policy and the selection code never import the engine. |
| `readerModel.ts` | Pure. The reader's state ⇄ windowing policy, and scroll ⇄ `Locator`. |
| `selection.ts` | Reads the live DOM selection out of a mounted text layer and calls `features/selection/anchor.ts` to build the durable `Anchor`. |
| `PdfPage.tsx` | One mounted page: canvas + PDF.js text layer + marks overlay. Renders, reports its pixel size, releases everything on unmount. |
| `stores.ts` | Dexie-backed `ProgressStore`, bookmark writer, mark writer. Supplies persistence only; the policy lives in the feature modules. |
| `../ReaderScreen.tsx` | The screen: file open, windowing, selection, marks, progress, bookmarks. |

Nothing in this directory duplicates logic that already exists and is already tested:

- **windowing** (`planFor` → `planWindow`) decides what stays mounted, what renders, what is
  released and what is cancelled. The screen passes state in and obeys.
- **validation** (`validatePdfImport`) is the trust boundary for the picked file.
- **identity** (`newDocumentId`, `sha256`) assigns a stable id immediately and hashes in the background.
- **anchors** (`captureAnchor`, `disambiguate`, `pageFractionOf`) build and re-find every stored quote.
- **marks** (`saveMark`) validate the locator and write the row.
- **progress** (`queueProgress`, `mustFlushNow`, `persistProgress`) debounce, flush and refuse a stale write.
- **bookmarks** (`makeBookmark`, `saveBookmark`, `announce`) own labels and real write outcomes.

## The three hard constraints, and where they are enforced

**No geometry is persisted.** Every stored position is `{ pageIndex, pageFraction }`, where the
fraction is a *scroll position within a page* (`locatorAt`). Selection rectangles are read from
`getBoundingClientRect` for popover placement and for painting the marks overlay, and never reach
a row: `saveMark` has no field for them, and the bookmark/progress locators are constructed by
`locatorAt`. `tests/ui/reader/readerModel.test.ts` asserts a stored locator matches no
`bbox|rect|top|left|width|height|coord`.

**No network egress of document data.** The worker is bundled by Vite from
`pdfjs-dist/build/pdf.worker.mjs?worker`, so it is same-origin and version-locked; there is no CDN
and no runtime worker URL to drift. `getDocument` is called with the bytes, never a URL. `cmaps`
and `standard_fonts` are read from the same origin (`/pdfjs/…`).

**Rendering starts independently of hashing.** `openFile` validates, opens, and renders; the
SHA-256 and the Dexie write happen in a floating promise afterwards. The toolbar shows
`hashing…` and then `saved locally` when the write actually resolves — never before.

**Zoom cannot allocate an unbounded canvas.** `plan.scale` is `pixelScale(devicePixelRatio)`, capped
by `MAX_DEVICE_PIXEL_RATIO`, and both canvas edges are capped by `MAX_CANVAS_EDGE`, inside
`windowing.ts`. The zoom control is separately clamped to 0.5–4. Note that zoom multiplies the CSS
box only; multiplying it into the pixel scale as well would allocate quadratically.

## Manual test steps

Requires a browser. Nothing below is covered by `vitest`, because rendering needs a canvas and a
DOM, and this environment has neither.

```bash
npm install
# a real 6-page PDF with a real text layer, written to dist/
npx vite-node tests/ui/reader/writeFixture.ts dist/sample-reader-fixture.pdf
npm run dev
```

Open the printed URL, then:

1. **Open.** Click `Open PDF…` and choose `dist/sample-reader-fixture.pdf`. Page 1 renders with
   visible text. The toolbar shows `6 pages mounted`, `Page 1 of 6`, and `hashing…` for a moment
   before `saved locally`.
   *Expect:* a canvas with the page bitmap, and `.textLayer` spans sitting invisibly on top of it.
   *Check:* `document.querySelectorAll('.reader__page canvas').length` is 3–5, not 6 — the
   windowing policy only mounts a window.
2. **Page through.** Click `Next ›` three times.
   *Expect:* `Page 4 of 6`, and the window slid forward — canvases for pages 1–2 are gone from the
   DOM, not merely blank.
3. **Windowing.** Scroll slowly from page 1 to page 2.
   *Expect:* the count in the toolbar stays within the budget; at a phone-width viewport it drops
   to 2 mounted pages because three DPR-2 page canvases exceed the 24 MiB phone budget.
4. **Selection → mark.** On page 4, select the sentence *"Progress is saved after the position
   settles"* with the mouse. A popover appears with the quote and four colour buttons.
   *Expect:* click `Y`. A yellow highlight appears over that text, and a screen reader (or the
   live region, `role="status"`) announces `Marked: …`.
   *Check:* `await db.marks.toArray()` — the anchor has `anchorState: "unresolved"` and a locator of
   `{ pageIndex: 3, pageFraction }`, with no rectangle anywhere in the row.
5. **Mark re-find on remount.** Jump to page 1 and back to page 4.
   *Expect:* the yellow highlight is still drawn. The mark was re-found in the current page text by
   `disambiguate`, not remembered as a box.
6. **Bookmark.** Click `⚑ Bookmark`, then press `b`.
   *Expect:* the button becomes pressed and reads `Bookmarked`; a chip appears in the bookmark bar;
   the live region announces `Bookmark added: Page 4`. Pressing `b` again removes it and announces
   `Bookmark removed`.
   *Check:* two bookmarks on the same page at different scroll positions coexist, because
   `pageFraction` distinguishes them.
7. **Progress + restore.** Scroll about halfway down page 4, wait ~1s, then reload the browser and
   reopen the same file.
   *Expect:* the status line reads `position saved` after the write resolves, and the reader
   reopens on the page and line you left. (A freshly hashed document has no saved row yet, so on a
   first open this step demonstrates the write; the restore is exercised once the document row and
   its progress row exist for that documentId.)
8. **Zoom.** Click `+` to 200% and 400%.
   *Expect:* the page box grows, the text stays selectable, and the toolbar's `canvas WxH @Nx`
   readout stops growing past the cap — at 400% on a DPR-2 display the scale reads `2×` and the
   edges stay under 8192.
9. **Password / damaged.** Open a password-protected PDF.
   *Expect:* `This file could not be opened` plus a password field, and the document opens once a
   password is supplied. Open a `.pdf` that is really a ZIP.
   *Expect:* the validation message from `validate.ts` and no attempt to render.
10. **Offline.** Once `cmaps`/`standard_fonts` exist under `public/pdfjs/`, disconnect the network
    and repeat step 1. Nothing in this path makes a network request for the document.

## What the tests cover, and what they do not

```bash
npx vitest run tests/ui/reader/
```

Covered by tests:

- the windowing policy as the screen drives it — mounted window, release list, supersession
  cancels, hidden-tab pause, phone budget shrink;
- zoom clamping and the canvas caps;
- scroll ⇄ page ⇄ fraction ⇄ `Locator`, including the restore round trip;
- the progress debounce/flush/conflict/failure rules and the revision guard;
- the bookmark capture, save, failure and announcement rules;
- **real pdfjs against real PDF bytes** (`pdfEngine.test.ts` uses the Node legacy build and the
  byte-accurate fixture): page count, 0-based page identity, per-page text, viewport geometry,
  release, and the adapter's own error classification.

Not covered by tests, and honestly stated:

- **canvas rasterization** and the `?worker` bundle at runtime — both need a browser. The build
  proves the worker is emitted (`dist/assets/pdf.worker-*.js`); it does not prove the pixels paint.
- the text layer's DOM geometry and real selection, since `--total-scale-factor` and
  `getClientRects` need a live layout;
- the Dexie writes, since IndexedDB does not exist in the test environment.
