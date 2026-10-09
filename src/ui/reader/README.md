# Reader

`ReaderScreen.tsx` is the shared reader for PDF, EPUB, TXT, and Markdown. `rawDocument.ts` supplies format-native reading units and locators. PDF.js extracts text in its worker; EPUB uses the existing archive validator and sanitizer; Markdown uses the existing parser and sanitizer; TXT uses the encoding decoder and chunker.

- **Paged:** exactly one reading unit, no canvas or positioned glyph overlay.
- **Scroll:** native IntersectionObserver parses units within 800px of the viewport. Sequential extraction and eight-unit caches bound text work. Measured placeholder heights preserve the scroll stack when text leaves the active range. The toolbar stays above the document's own scroll area.
- **Position:** shared import hashing reuses document identity. Progress writes are serialized and revision-checked. Switching tabs preserves the mounted reader. Reopening restores the saved page, chapter, or text section.
- **Selection:** native DOM text supplies quote offsets. Highlights use the same raw text and prefix/suffix context. Jump waits for extraction and scrolls only the document area.
- **Learning:** dictionary lookup is local. Online translation requires an explicit button click and shows the submitted sentence.

PDF line spacing and indentation supply paragraph boundaries. Line-break fragments are joined only when the combined word exists in the local dictionary and at least one fragment does not. Existing OCR spelling and unusual letter spacing can remain. Image-only pages require OCR; this reader does not invent text for them. Figures and original print layout are not reproduced in text mode.

Verification: `npm test`, `npm run build`, `npm run offline:smoke`. Browser checks use actual file inputs, native selection, page navigation, saved highlights, tab switching, duplicate reopen, and scrolling on the supplied 401-page PDF. Test-only sample documents are available under `public/sample/`.
