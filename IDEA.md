# English Reading Companion

## Comprehensive implementation plan

**Prepared:** 22 September 2026  
**Status:** Proposed implementation baseline; feasibility gates precede release commitments  
**Primary platform:** Local-first browser application and installable PWA  
**Optional platform:** Tauri desktop wrapper  
**Language direction:** English to Indonesian  
**Source context:** “Plan English Reading App,” including its final parser decision

> Help the learner understand enough English to keep reading. Keep the book, rather than the translation interface, at the center of the experience.

This plan specifies the complete target product and a staged route to it. It does not claim that the application, integrations, or performance results already exist. All budgets below are proposed acceptance targets. Dependency documentation was checked on the preparation date; published package versions and behavior must be pinned and tested in Phase 0.

## Contents

1. [Product scope](#1-product-scope)
2. [Verified decisions and feasibility gates](#2-verified-decisions-and-feasibility-gates)
3. [Architecture and platform capabilities](#3-architecture-and-platform-capabilities)
4. [User journeys and interface](#4-user-journeys-and-interface)
5. [Document import and identity](#5-document-import-and-identity)
6. [PDF rendering and semantic extraction](#6-pdf-rendering-and-semantic-extraction)
7. [Selection and contextual alignment](#7-selection-and-contextual-alignment)
8. [EPUB, TXT, and Markdown](#8-epub-txt-and-markdown)
9. [Local dictionary](#9-local-dictionary)
10. [Optional contextual AI](#10-optional-contextual-ai)
11. [Vocabulary and review](#11-vocabulary-and-review)
12. [Data models](#12-data-models)
13. [Persistence, migration, and backup](#13-persistence-migration-and-backup)
14. [Worker and native contracts](#14-worker-and-native-contracts)
15. [Repository and dependencies](#15-repository-and-dependencies)
16. [Performance budgets](#16-performance-budgets)
17. [Benchmark plan](#17-benchmark-plan)
18. [Security and privacy](#18-security-and-privacy)
19. [PWA and desktop delivery](#19-pwa-and-desktop-delivery)
20. [Testing strategy](#20-testing-strategy)
21. [CI/CD and operations](#21-cicd-and-operations)
22. [Implementation phases](#22-implementation-phases)
23. [Architecture decision records](#23-architecture-decision-records)
24. [Release acceptance criteria](#24-release-acceptance-criteria)
25. [Risks and open decisions](#25-risks-and-open-decisions)
26. [Source references](#26-source-references)

## 1. Product scope

### Intended users

Indonesian learners reading English novels, textbooks, articles, and professional material on a laptop or phone. Users should be able to read, look up words, and keep learning records without an account, network connection, or paid service after the required assets are installed.

### Release scope

| Capability | Core release v0.1 | Subsequent delivery |
|---|---|---|
| PDF | Render, select, navigate, restore progress; semantic extraction with graceful fallback | Better difficult-layout handling; optional OCR |
| EPUB | Reflowable, DRM-free EPUB; navigation and text selection | Fixed-layout compatibility improvements |
| TXT / Markdown | Local text reading, selection, appearance controls | Additional encoding support where demanded |
| Dictionary | Offline English–Indonesian lookup, exact and conservative inflection matches | Expanded licensed packs and coverage |
| Learning | Save words and phrases, source context, edit meanings, basic reveal/review | Scheduled spaced repetition |
| AI | Optional explicit explanation through one validated transport/provider | Additional providers, optional local models |
| Storage | IndexedDB/Dexie, import/export, quota recovery | Optional desktop file-backed originals |
| Distribution | Static web application and installable PWA | Optional Tauri desktop builds |

Exclude accounts, cloud synchronization, automatic whole-book translation, social features, AI chat over entire books, DRM circumvention, DOCX/MOBI/AZW import, advanced PDF annotation, and a default backend. OCR and OpenDataLoader are explicitly later additions, not prerequisites for v0.1.

### Product rules

- Opening a document means opening a local file, not uploading it.
- Rendering starts independently of classification, hashing, dictionary installation, and semantic extraction.
- Hover performs local lookup only. A dictionary miss never silently starts a network request.
- Text, definitions, and saved learning records remain useful when AI is disabled.
- Display dictionary senses and AI explanations with distinct source labels.
- Preserve original English alongside any explanation. Do not replace the reading text with a translation.

## 2. Verified decisions and feasibility gates

### What the current upstream material supports

PDF.js remains the visual engine. Its official examples demonstrate asynchronous document loading, page rendering, viewport transforms, and device-pixel scaling. Use its maintained text-layer facilities for selection. [PDF.js examples](https://mozilla.github.io/pdf.js/examples/)

The browser package `@firecrawl/pdf-inspector-wasm` accepts PDF bytes, supports selected-page processing, and runs synchronously after initialization. Its documented build is single-threaded and does not require cross-origin isolation. Run it inside a dedicated worker. Browser OCR requires a separate implementation. [WASM documentation](https://github.com/firecrawl/pdf-inspector/blob/main/wasm/README.md)

**Correction to the earlier conversation:** the inspected WASM wrapper returns Markdown, classification, and layout metadata; it does not export Rust's positioned-text API or a persistent parsed-document handle. Keeping bytes in a worker avoids repeated message transfers but does not prove that subsequent extraction calls reuse a parsed PDF. Do not promise browser bounding-box parity or constant-cost page extraction. [Inspected WASM wrapper](https://github.com/firecrawl/pdf-inspector/blob/main/wasm/src/lib.rs)

The native Rust API provides positioned extraction and selected-page controls. Page numbering differs between some high-level and lower-level APIs, so adapters must normalize it. Native OCR is optional and has additional runtime requirements. [Rust API documentation](https://github.com/firecrawl/pdf-inspector/blob/main/docs/rust-api.md)

OpenDataLoader requires Java 11+ in its documented setup. Reserve it for an explicit later desktop/local-service fallback. Its local and hybrid modes must be evaluated separately. [OpenDataLoader](https://github.com/opendataloader-project/opendataloader-pdf)

### Phase 0 gates

1. **Package gate:** install published WASM and Rust releases; record package versions, checksums, repository revisions, exposed APIs, and licenses. Source on `main` is not proof that an npm release contains a feature.
2. **Browser gate:** verify worker initialization, selected pages, offline WASM loading, mobile memory, error handling, and password behavior on actual supported browsers.
3. **Alignment gate:** demonstrate reliable text-based matching between PDF.js selections and inspector output without assuming browser position data exists.
4. **Scheduling gate:** measure repeated single-page, small-batch, and whole-document calls. Choose batch size from total cost, including repeated document loading.
5. **Dictionary gate:** verify the exact English–Indonesian artifact, attribution, redistribution terms, coverage, and normalized pack size.
6. **AI gate:** validate one actual endpoint's browser permissions, credential rules, payload limits, and deployment transport before exposing it as supported.

If inspector fails a gate, preserve it as the intended primary semantic parser, record the blocker, and ship the validated PDF.js fallback only with an explicit scope exception. Do not silently substitute a different architecture.

## 3. Architecture and platform capabilities

### System structure

```text
Local file
  |
  +-- Import validation and local persistence
  |
  +-- PDF.js worker -------- Canvas + text layer -------- Reader UI
  |
  +-- Semantic adapter ---- WASM worker (browser)
  |                     \- Rust task (Tauri)
  |                              |
  |                        Normalized page text
  |                              |
  +-- EPUB / TXT / MD ------ Selection + source locator
                                 |
                           Local dictionary
                                 |
                        Optional explicit AI request
                                 |
                        Vocabulary and review

Dexie / IndexedDB: library, originals, progress, semantic cache,
dictionary packs, vocabulary, review events, optional AI cache
```

The UI consumes one small document/selection model. Use adapters only at real boundaries: document format, semantic runtime, and AI transport. Keep ordinary application logic in functions and feature modules. Avoid a general plugin system or service framework.

### Capability matrix

| Capability | Browser / PWA | Optional Tauri |
|---|---|---|
| PDF display and native text selection | PDF.js | PDF.js in WebView |
| Primary semantic extraction | Inspector WASM worker | Inspector Rust crate |
| Semantic bounding boxes | Unavailable in inspected wrapper; PDF.js geometry fallback | Native API, normalized and tested |
| Local dictionary and learning data | Dexie / IndexedDB | Same web storage initially |
| Original document storage | IndexedDB Blob | Same initially; managed files only if needed |
| AI transport | Approved direct endpoint or optional relay | Narrow native HTTP command |
| Credential persistence | None by default | OS credential store if implemented and verified |
| OCR | Deferred, separate implementation | Deferred opt-in native feature |
| OpenDataLoader | No in-page Java runtime; external local service only later | Optional managed sidecar later |
| Network needed for normal reading | No, after offline setup | No |

Desktop is a wrapper plus a native parser boundary. It does not require rewriting the library, reader, dictionary, or learning interfaces.

## 4. User journeys and interface

### Primary surfaces

- **Library:** Open file, recent documents, progress, format, storage status, remove document.
- **Reader:** Page/chapter navigation, appearance settings, selection, lookup card, progress.
- **Vocabulary:** Search/filter saved words and phrases, edit, revisit source, export, review.
- **Settings:** Dictionary pack, AI opt-in, privacy, storage, backups, accessibility, licenses.

### Open and resume

1. The user chooses or drops a supported local file.
2. The app validates basic limits and immediately starts the format renderer.
3. The first readable page or chapter appears. Background tasks show unobtrusive status.
4. The app saves the original and progress when storage succeeds.
5. A later open restores the saved location independently of semantic cache readiness.

Distinguish **saved locally**, **temporary session**, and **offline assets incomplete**. Never imply persistence before a write succeeds.

### Lookup

Desktop hover waits 350 ms before local lookup. Moving away cancels it. Selection, keyboard activation, and touch selection work without hover. On phones, preserve native long-press handles and display an accessible lookup action after selection settles.

The card shows the selected form, matched dictionary headword, Indonesian senses, part of speech where available, source, Save, and optional Explain. A miss says that no local entry was found and offers manual meaning entry or explicit AI explanation.

### Accessibility and appearance

Provide visible focus, keyboard navigation, Escape dismissal, focus restoration, touch targets of at least 44 CSS pixels, reduced-motion support, and sufficient contrast. Hover content must also be available through selection and keyboard controls. Support light/dark themes, adjustable text size and line height for reflowable documents, and PDF zoom without changing the original layout.

PDF accessibility depends on source quality. Offer extracted text as an auxiliary reading view when reliable; label it as reconstructed. Do not claim every untagged PDF becomes fully accessible. Validate with screen readers and real mobile selection, not only automated checks.

## 5. Document import and identity

### Import lifecycle

Use states `validating`, `opening`, `saving`, `ready`, `temporary`, and `failed`. Semantic processing has a separate state so it cannot block display.

Check extension, reported MIME type, and format signatures together. Treat filenames and document metadata as untrusted text. Bound file size, EPUB expansion, page count where known, and extraction output. Show actionable errors for unsupported, damaged, encrypted, and oversized files.

### Identity and fingerprinting

- Assign a random stable `documentId` immediately.
- Compute SHA-256 over original bytes in background; do not wait for it before display.
- Store the full content hash separately from the document ID. A filename or PDF metadata fingerprint is not sufficient for deduplication.
- For moderate files, worker-side Web Crypto hashing is acceptable. Its whole-buffer memory cost must be measured; move to incremental hashing only if the large-file gate requires it.
- Until hashing completes, cache under the temporary document ID. Promote cache identity transactionally after hashing.
- An existing hash triggers a reuse/duplicate decision without overwriting saved vocabulary or progress. Concurrent imports use a serialized duplicate check and reconciliation.

For v0.1, deduplicate by exact bytes, not by book title or approximate content. Keep the selected `File` available for rendering even if a database save fails.

### Default limits

Start with a 100 MiB supported PDF limit and a 50 MiB phone performance tier. Larger files may open in a clearly marked render-only mode after a warning; semantic parsing remains disabled unless the benchmark validates that tier. Use 25 MiB compressed / 100 MiB expanded limits for EPUB, 10,000 ZIP entries, and a 100:1 expansion-ratio ceiling. Limit TXT/Markdown to 20 MiB initially. Phase 0 may tighten these limits based on measured devices.

Limits are safety bounds, not proof that every smaller file can render. Catch allocation failures and terminate stalled workers.

## 6. PDF rendering and semantic extraction

### Display path

Load `pdfjs-dist` lazily with a matching, self-hosted worker. Render the first visible page with its text layer before background enrichment. Use the library's public APIs and matching text-layer styles; do not build a custom glyph renderer.

Maintain placeholders for page dimensions to avoid scroll jumps. Render visible pages first, then adjacent pages. Start with a window of the visible page plus two pages on either side on desktop, and one on either side on phones. Reduce the window when canvas memory reaches its limit.

Cancel superseded render tasks on zoom or navigation. Release distant canvases, text layers, object URLs, and page resources. Keep an active selection's page mounted until selection ends. Pause speculative work when the tab is hidden.

Canvas memory is approximately `width × height × 4` bytes before other overhead. Cap effective device-pixel scaling and individual canvas dimensions. Zooming must not allocate an unbounded canvas.

### Semantic path

1. Load inspector WASM only when a PDF needs semantic processing.
2. Initialize one dedicated parser worker for the active document.
3. Let first-page rendering receive priority. Start classification/extraction without blocking that path.
4. Extract the visible page first; then process a bounded nearby window.
5. Normalize output into page text and blocks with provenance and quality flags.
6. Persist completed pages incrementally; resume missing pages on later opens.
7. Optionally complete small documents during idle periods after the benchmark establishes an eligible size/page tier.

Start with a semantic window of the current page plus two pages each side, batched where beneficial. Do not extract an entire large book merely because a vendor benchmark reports fast native throughput. Page filtering can reduce extraction output without eliminating whole-file parsing cost.

Use fidelity-oriented output for reading context; compact output must pass tests proving it does not damage sentences. In the current WASM integration, convert semantic Markdown to a safe text/block representation. Treat Markdown as an adapter input, not the canonical data model.

Associate output with pages only through validated markers or single-page requests. If markers are missing or ambiguous, retry one page at a time within the job budget. Never infer page boundaries by dividing text lengths.

### Memory ownership

The original `Blob` is durable storage. PDF.js and the semantic worker require independent access to bytes. A transferred `ArrayBuffer` becomes detached in its sender and cannot be handed to both consumers.

Either read separate buffers from the Blob or make one intentional copy before transfer. Account for both consumers, WASM linear memory, parsed structures, and canvas memory. Retain parser input once per active document rather than sending it with every page request. Release it when closing or changing documents.

No shared-memory design is required initially. Persisting bytes in a worker is not the same as persisting the parser's internal document representation.

### Classification and fallback

Classification is a routing hint, not proof that every page has correct text. Inspect page-level emptiness, encoding warnings, replacement characters, and selection alignment separately.

| Condition | Reader behavior |
|---|---|
| Inspector output is usable | Use it as primary context source |
| Inspector is pending or fails | Use local PDF.js selected text and conservative nearby text |
| Output is ambiguous or garbled | Use the exact selection; omit unreliable sentence context |
| Page has no selectable text | Keep rendering; explain that OCR is unavailable in this release |
| Mixed PDF | Enable lookup on text pages; show page-specific limitations |
| Password required | Prompt locally; keep password in memory only; allow render-only operation if semantic support differs |
| Worker exceeds timeout | Terminate it, preserve reading, allow explicit retry |

Use a configurable 15-second parser-job watchdog initially. Canceling a synchronous WASM call requires terminating its worker; a queued cancellation message cannot interrupt the running call.

### Cache identity

Use `(contentHash, parserEngine, parserVersion, optionsHash, normalizerVersion, pageIndex)` as the semantic cache key. Include output schema version and relevant fidelity settings. Parser or normalizer changes invalidate derived data only. Progress, vocabulary, and original files survive.

## 7. Selection and contextual alignment

### Shared selection model

Capture exact selected text, document ID, location, page/chapter, quote prefix/suffix, and viewport rectangles. Store logical source anchors separately from temporary screen coordinates.

Use `Intl.Segmenter` for English word and sentence boundaries where available. Preserve a tested fallback for contractions, apostrophes, hyphens, and punctuation. Segmenter boundaries do not determine dictionary senses or guarantee grammatical sentences.

### PDF alignment procedure

1. Read the selected PDF.js text and its page identity.
2. Normalize whitespace, ligatures, and apostrophe variants for matching; retain original text and an offset mapping.
3. Search only relevant semantic pages for the normalized selection.
4. Resolve repeated phrases using quote prefix/suffix and neighboring selected text.
5. Accept semantic sentence context only when the match is unique or passes the tested disambiguation rule.
6. If ambiguous, use the exact selection or verified PDF.js context. Label missing context rather than guessing.

Do not join separate columns, headers, footers, table cells, or page boundaries just because strings are adjacent. Preserve real hyphens; reverse line-end hyphenation only when normalization has supporting evidence. Keep source mappings so saved quotes remain recognizable.

Native positioned text can improve disambiguation later. Normalize CropBox, MediaBox, page rotation, coordinate origin, and viewport scaling in one adapter. Never compare CSS pixels directly with PDF points. Validate 0°, 90°, 180°, and 270° pages and non-zero crop origins.

For cross-page selection, preserve an ordered list of source spans. Cap AI input separately. A stale parser response must never move a popup or change the meaning of a newer selection.

## 8. EPUB, TXT, and Markdown

### EPUB

Use a pinned, validated `epub.js` release for reflowable DRM-free books. Its documentation supports browser rendering and warns that enabling scripted content weakens isolation. Keep book scripting disabled. [epub.js](https://github.com/futurepress/epub.js)

Validate ZIP contents before rendering, including traversal paths, entry counts, expansion limits, and supported encryption. Parse OPF metadata, spine order, and navigation. Sanitize chapter XHTML and CSS, then render chapters in an isolated iframe with scripts, forms, top navigation, and network access disabled.

The iframe policy must still permit the trusted host's selection integration. If same-origin access is needed, never combine it with permission to run publication scripts. Restrict resource loading to validated, rewritten local assets. Revoke their object URLs on close.

Save EPUB CFI plus spine item and quote context. Build expensive location indexes after opening. Preserve a quote fallback when renderer upgrades alter CFI behavior. Scope v0.1 to reflowable books; report unsupported fixed-layout or DRM content explicitly.

### TXT

Decode UTF-8 with BOM handling. Detect obvious decoding failure and offer a limited encoding selector instead of silently replacing many characters. Split large files into paragraph chunks while preserving stable source offsets and line breaks.

### Markdown

Use one maintained parser with raw HTML disabled, then sanitize generated HTML. Disable remote images and unsafe links by default. Store source offsets or stable block IDs plus quote anchors; headings alone are not unique locators. Do not execute embedded HTML, scripts, or code blocks.

The four formats feed the same lookup and vocabulary services. Reflowable formats derive context from sanitized text nodes, not the PDF semantic parser.

## 9. Local dictionary

### Source and packaging

Evaluate Open DSL's one-way English–Indonesian Wiktionary-derived dictionary as the first candidate. The repository lists the language pair and describes CC BY-SA 3.0 / GFDL licensing with artifact-specific attribution information. Verify the chosen download's notices before redistribution. [Dictionary source](https://github.com/open-dsl-dict/wiktionary-dict)

Do not treat bilingual entries as a comprehensive English dictionary. Measure common-word coverage, inflections, idioms, sense quality, and Indonesian naturalness with a reviewed sample.

Build the pack offline during development/release:

1. Pin the source file and checksum.
2. Parse DSL markup and aliases; preserve headword, senses, part of speech, and provenance when present.
3. Normalize lookup keys without altering displayed forms.
4. Emit compressed, versioned JSON chunks and a manifest with sizes, hashes, entry count, source revision, license, and attribution.
5. Validate every output record and audit a representative bilingual sample.
6. Install chunks into a separate Dexie dictionary database in bounded transactions.

Set a target of 10 MiB compressed for the initial pack. If the validated source exceeds it, offer a transparent optional download or clearly labeled starter pack. Do not silently truncate meanings to meet a bundle target.

Keep the previous pack active until all new chunks pass validation. Flip the active version atomically, then remove the old version. Interrupted downloads must not replace a working dictionary.

### Lookup order

Exact surface form; normalized case/apostrophe form; explicit aliases; known irregular form; conservative suffix candidates that exist in the dictionary; exact phrase entry. Never invent a lemma or translation on a miss.

Show the matched headword when it differs from the selection. Present multiple senses without claiming one is contextually correct. Cache recent queries in a bounded in-memory map. Avoid scanning the full dataset per lookup; use indexed normalized headwords and aliases.

Dictionary setup is complete only after a lookup succeeds with network disabled. Display source attribution in the card and a full license notice in Settings.

## 10. Optional contextual AI

### Behavior and scope

AI is disabled by default and invoked only by Explain or Translate selection. The user chooses a provider/endpoint and sees what text will leave the device. Implement one provider end to end before adding others. Treat free tiers, prices, model names, and quotas as configuration verified at implementation time; never promise unlimited free translation.

Send the selected text and at most one useful sentence by default. A paragraph is an explicit expansion. Set initial limits of 500 selected characters, 2,000 total input characters, and a bounded short response. Allow users to edit or remove context before sending. Do not send the book, filename, hash, reading history, or vocabulary list.

### Transport decision

| Environment | Supported pattern | Credential policy |
|---|---|---|
| Static PWA | Direct call only when endpoint explicitly permits browser use and CORS | User-owned credential in memory for the session; exposure explained |
| Optional hosted integration | Authenticated, rate-limited relay with strict provider allowlist | Service credential remains server-side |
| Tauri | Narrow native HTTP command to configured approved endpoints | OS credential store where supported; never send the secret back to the WebView |

The PWA must not require a backend for reading. If no secure, supported direct transport is available, keep AI unavailable until the optional relay or desktop transport is configured. Never solve CORS by sending keys through an arbitrary proxy. Do not embed a shared secret in a frontend environment variable.

### Application contract

Use a small provider function accepting selected text, optional context, target language `id`, and an abort signal. Return validated structured data:

```ts
type LearningExplanation = {
  naturalTranslation: string;
  contextualMeaning?: string;
  partOfSpeech?: string;
  grammarNote?: string;
  simplerEnglish?: string;
  example?: { english: string; indonesian: string };
  provider: string;
  model: string;
  promptVersion: string;
};
```

Request short, natural, neutral Indonesian. Preserve proper nouns and established technical terminology. Distinguish literal meaning, contextual meaning, and idioms. Treat source text as quoted data, never as instructions. Do not provide the model with tools or permission to fetch URLs.

Validate response shape, length, and string fields. Render it as text. Reject malformed or oversized results. AI output is a suggestion the learner can edit, not a dictionary fact.

### Reliability and cache

Allow one active request per selection; debounce double clicks. Cancel when the user changes documents, and discard late results by request ID. Use a 20-second timeout, visible retry, and no automatic retry of a potentially billed request. Report authentication, quota, network, timeout, and unsupported-provider errors separately.

An optional local response cache uses a hash of normalized selection, exact submitted context, target language, provider, model, prompt version, and generation settings. Apply a 30-day TTL and bounded LRU retention. Exclude credentials from keys and records. A cached phrase from one context must not overwrite an explanation from another.

Local neural translation and a local AI endpoint remain later experiments. They require explicit downloads, licensing checks, storage reporting, and their own device benchmarks.

## 11. Vocabulary and review

### Capture

Save only on an explicit action. Preserve surface text, optional lemma, chosen meaning, source sentence, locator, dictionary/AI provenance, and user notes. Users may save a phrase without a dictionary match and supply the meaning themselves.

Keep different senses separate. For an existing term and identical chosen meaning, offer to attach another occurrence rather than forcing a merge. An occurrence stores its own document and locator. Deleting a book does not silently delete saved vocabulary; retain its title snapshot and mark the source unavailable.

### Basic review in v0.1

Show the English word/phrase and optional original sentence, reveal the saved Indonesian meaning, and let the user mark Learning or Known. Record each review event. Present a simple queue ordered by least recently reviewed, with a daily session size chosen by the learner. No scheduled-learning claim is required for this first queue.

### Scheduled review in v0.2

Use a transparent fixed ladder initially: 1, 3, 7, 14, and 30 days. Again resets to a 10-minute retry; Got it advances one step, capped at 30 days. Store scheduling timestamps in UTC and display them locally. Known is an explicit suspension choice, not an automatic consequence of reaching the last step.

Write card state and its review event in one transaction. A unique session event ID prevents a double tap from recording twice. Explain that this is a basic schedule, not a scientifically validated personalization algorithm. Adopt a maintained scheduler only if actual learning requirements justify it.

Support JSON backup and UTF-8 CSV export. Escape CSV cells that begin with spreadsheet formula characters. Import previews conflicts and preserves user edits.

## 12. Data models

These are application contracts, not upstream parser types. IDs are random strings, timestamps are UTC milliseconds, text offsets are UTF-16 code-unit offsets unless explicitly converted, and PDF page indexes are zero-based internally.

### Core types

```ts
type Format = "pdf" | "epub" | "txt" | "md";

type Locator =
  | { kind: "pdf"; pageIndex: number; pageFraction: number;
      quote?: string; prefix?: string; suffix?: string }
  | { kind: "epub"; spineHref: string; cfi?: string;
      quote?: string; prefix?: string; suffix?: string }
  | { kind: "text"; blockId: string; start: number; end: number;
      quote?: string; prefix?: string; suffix?: string };

type DocumentRecord = {
  id: string;
  contentHash?: string;
  title: string;
  originalName: string;
  format: Format;
  byteSize: number;
  pageCount?: number;
  importedAt: number;
  lastOpenedAt: number;
  importState: "saving" | "ready" | "temporary" | "failed";
  assetId?: string;
};

type SemanticPage = {
  cacheKey: string;
  documentId: string;
  pageIndex: number;
  parser: string;
  parserVersion: string;
  optionsHash: string;
  normalizerVersion: string;
  schemaVersion: number;
  text: string;
  blocks: Array<{
    id: string;
    kind: "paragraph" | "heading" | "list" | "table" | "unknown";
    start: number;
    end: number;
    bbox?: { x: number; y: number; width: number; height: number };
  }>;
  coordinateSpace?: "normalized-display-page";
  source: "inspector-wasm" | "inspector-rust" | "pdfjs";
  quality: "usable" | "partial" | "unreliable" | "needs-ocr";
  warnings: string[];
  createdAt: number;
  lastAccessedAt: number;
};
```

Optional boxes use display-page coordinates normalized to `[0,1]`. Do not manufacture boxes for text-only output. Block IDs are stable within a cache version, not across parser upgrades. Persistent user anchors therefore include quotes and format-native locations.

### Stores and indexes

| Store | Required fields beyond ID | Indexes / constraints |
|---|---|---|
| `documents` | Core document record | `contentHash`, `lastOpenedAt`, `format` |
| `assets` | `documentId`, Blob, MIME, byte size, checksum | Unique `documentId` for v0.1 |
| `progress` | `documentId`, locator, progression estimate, updated time, revision | Primary `documentId` |
| `semanticPages` | Semantic page contract | Primary `cacheKey`; `documentId`, `[documentId+pageIndex]`, `lastAccessedAt` |
| `bookmarks` | `documentId`, locator, label, created time | `documentId`, `createdAt` |
| `vocabulary` | surface, normalized form, optional lemma, meaning, note, provenance, status, timestamps | `normalizedForm`, `status`, `updatedAt` |
| `occurrences` | `vocabularyId`, nullable `documentId`, title snapshot, locator, sentence | `vocabularyId`, `documentId` |
| `reviewCards` | `vocabularyId`, stage, due time, last review, suspended | Primary `vocabularyId`; `dueAt` |
| `reviewEvents` | event ID, card ID, grade, before/after schedule, UTC time | Primary event ID; `[cardId+reviewedAt]` |
| `aiCache` | request hash, result, provider/model/prompt, expiry, access time | Primary request hash; `expiresAt`, `lastAccessedAt` |
| `settings` | key, JSON-safe value, schema version | Primary key; secrets prohibited |

The separate dictionary database contains `packs` and `entries`. Use compound keys `(packVersion, normalizedHeadword, senseId)` and indexed aliases. The pack manifest records source URLs, hashes, license notices, schema version, entry count, and installation state.

Provenance is structured: `kind`, source/pack version or provider/model/prompt version, creation time, and whether the user edited the meaning. Do not store a provider key with provenance.

## 13. Persistence, migration, and backup

Use Dexie for schema versions, indexed queries, and transactions over IndexedDB. Define indexes for actual queries; do not index large page text or document Blobs. [Dexie design documentation](https://dexie.org/docs/Tutorial/Design)

### Durability rules

- Original files and learning records are user data. Parsed text, thumbnails, and AI caches are replaceable.
- Debounce progress writes to approximately one second during movement. Save on page/chapter changes and visibility changes; do not rely solely on unload events.
- Record whether a write succeeded before displaying Saved.
- Use a progress revision check for conflicting tabs and notify other tabs through `BroadcastChannel`. Do not let a stale tab overwrite a newer location without detection.
- Close old database connections on version changes and ask the user to reload that tab.

Browser quotas and eviction policies vary. Persistent-storage requests can be denied and do not replace backups. Use `navigator.storage.estimate()` and request persistence after meaningful user activity. Explain that clearing site data removes local books and learning data. [Browser storage behavior](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)

### Quota recovery

On quota errors, evict derived caches first, retry once, and otherwise keep the reading session temporary. Never automatically delete vocabulary or original files. Show storage by category and offer explicit removal. Estimate import headroom for the original, dictionary installation, and temporary upgrade copies.

### Migration policy

Version the user database independently from dictionary packs and parser caches. Use additive changes where possible. Run bounded migrations and fixture-based upgrades from every supported prior version. Avoid parsing documents or contacting the network within upgrade transactions.

For a destructive schema change, require a recoverable export and document the migration path before rollout. A rolled-back application must refuse incompatible newer data gracefully; it must not clear the database to make itself run.

### Backup and restore

Provide a versioned JSON learning-data export in v0.1, excluding API keys and replaceable caches. An optional archive may include original files; show its expected size first. Include checksums, format version, and source attribution metadata.

Validate imports before writes, reject excessive nesting and unsafe keys, preview counts/conflicts, and restore transactionally where practical. Default to merging new records and preserving existing user edits. Test a complete round trip into a fresh profile. Export files contain private reading information and are unencrypted unless an explicit encrypted format is later added.

## 14. Worker and native contracts

### Browser messages

Every request includes `requestId`, `documentId`, and `generation`. Increment generation on close/reopen and ignore responses from older generations.

| Message | Input | Result |
|---|---|---|
| `OPEN` | Original bytes once, optional in-memory password | Runtime and capability readiness |
| `CLASSIFY` | Active document identity | Classification and warnings |
| `EXTRACT` | Bounded zero-based page list and options | Normalized page records |
| `CLOSE` | Active document identity | References released |

The adapter alone converts zero-based pages into each upstream API's convention. Validate requested indexes against page count. Requests contain no credentials.

Use one active extraction job and a bounded queue. Priorities are visible page, adjacent context, then optional idle work. Deduplicate requests and drop obsolete queued jobs. Do not claim fine-grained progress from a synchronous function; show completed batches and elapsed time.

### Tauri commands

Expose narrowly scoped commands such as `open_document`, `extract_pages`, and `close_document`. A native picker grants a validated file handle or opaque ID. The WebView must not pass arbitrary filesystem paths to the parser.

Run CPU-heavy parsing off the UI thread with bounded concurrency. Return only required normalized pages, not entire books. Closing a native task suppresses its result; a blocking Rust task may continue until completion. If strict interruption or untrusted-file isolation becomes necessary, use a supervised subprocess in a later change rather than claiming task cancellation kills native work.

Keep runtime capability flags explicit: positioned text, password support, OCR availability, page filtering, and cancellation mode. Browser/native parity is defined at the normalized output contract, not by identical upstream function names.

## 15. Repository and dependencies

Use one repository and one web application. Start with React, TypeScript, Vite, `pdfjs-dist`, `@firecrawl/pdf-inspector-wasm`, Dexie, a validated EPUB renderer, one Markdown parser, and a maintained HTML sanitizer. Pin exact release resolutions in the lockfile. Use CSS and native controls before adding UI dependencies.

```text
english-reading-companion/
  src/
    app/                 # Routes, app shell, error boundaries
    features/
      library/           # Import, list, removal, storage status
      reader/
        pdf/             # PDF.js canvas, text layer, navigation
        epub/            # Chapter rendering and CFI
        text/            # TXT and Markdown
        selection/       # Shared selection and source anchors
      dictionary/        # Pack installation and lookup
      translation/       # Explicit AI request and provider transport
      vocabulary/        # Saved meanings and occurrences
      review/            # Queue and scheduling
      settings/          # Privacy, storage, backup, licenses
    document/            # Normalized contracts and semantic adapter
    db/                  # Dexie schema, migrations, scoped queries
    workers/             # Inspector, hashing/import work as needed
    platform/            # Browser/Tauri boundary only
  public/                # Icons and self-hosted static assets
  scripts/               # Dictionary build and benchmark runners
  tests/
    fixtures/            # Small redistributable documents
    integration/
    e2e/
    performance/
  docs/
    adr/
    benchmarks/
    privacy.md
    release-checklist.md
  src-tauri/             # Added in desktop phase, not scaffolded early
  .github/workflows/
  LICENSE
  THIRD_PARTY_NOTICES.md
```

Do not build a monorepo, generic repository layer, dependency injection container, or provider marketplace for the initial release. Add desktop code only when the web acceptance gates pass. Keep fixtures small and legally redistributable; reference private benchmark books by local manifest only.

## 16. Performance budgets

### Measurement profiles

Phase 0 records exact device models and OS/browser versions for one desktop with at least 8 GiB RAM, one Android phone with approximately 4 GiB RAM, and one supported iPhone. Freeze these profiles before comparing releases. CPU throttling supplements real devices; it does not replace them.

The standard PDF fixture is a 10 MiB, 100-page native-text book with embedded fonts and a moderate first page. Cold document open means a running application with no parsed-document cache. First installation includes downloading application assets and is measured separately.

| Metric | Desktop target | Phone target | Measurement boundary |
|---|---:|---:|---|
| First readable PDF page, cold document | p95 ≤ 1.5 s | p95 ≤ 3 s | File accepted to visible canvas and usable text layer |
| Reopen saved standard PDF | p95 ≤ 0.8 s | p95 ≤ 1.5 s | Library click to restored readable viewport |
| First EPUB/TXT/MD content, ≤ 5 MiB | p95 ≤ 1 s | p95 ≤ 2 s | File accepted to selectable content |
| Local lookup, installed pack | p95 ≤ 50 ms | p95 ≤ 100 ms | Query to populated card; excludes hover delay |
| Semantic context for visible page | p95 ≤ 1 s | p95 ≤ 2 s | Request to normalized result, WASM already initialized |
| Save vocabulary | p95 ≤ 100 ms | p95 ≤ 200 ms | Action to durable write confirmation |
| Selection UI response | p95 ≤ 100 ms | p95 ≤ 150 ms | Stable selection to local action shown |
| Standard-file app memory increment | ≤ 250 MiB | ≤ 150 MiB | Peak above idle baseline, where measurable |
| Active canvas allocation | ≤ 64 MiB | ≤ 24 MiB | Sum of active pixel buffers |

Additional delivery budgets:

- Initial app shell JavaScript: at most 250 KiB gzip, excluding lazy format engines.
- Total shell transfer including CSS/icons: at most 500 KiB compressed.
- Lazy PDF engine and worker: target at most 1.5 MiB compressed; dictionary and inspector measured separately.
- Inspector WASM and glue: provisional target at most 5 MiB compressed; verify actual published artifact in Phase 0.
- Default offline asset installation: target at most 20 MiB compressed, excluding user books; show any overage before download.
- Parsing must cause no main-thread long task above 50 ms in the standard interaction trace. Split dictionary installation and normalization work as needed.
- AI shows a pending state within 100 ms. Provider latency is reported separately and is not covered by offline latency guarantees.

Memory APIs vary by browser. Use browser/process profiling and actual low-memory behavior where direct measurement is unavailable; never report JavaScript heap alone as total memory. If a target fails, reduce concurrency, canvas scale, or semantic scope before increasing the budget. Record any approved budget change with evidence.

## 17. Benchmark plan

### Corpus

Create a versioned manifest of at least 30 redistributable or privately held test documents: 8 novels, 6 textbooks, 4 multi-column papers, 4 mixed/scanned books, 4 difficult PDFs, and 4 EPUB/text samples. Include 10, 50, and 100 MiB PDFs, long books, embedded fonts, ligatures, line hyphens, rotation, crop boxes, tables, broken encodings, repeated phrases, passwords, and malformed files.

Never commit copyrighted books without permission. Store hashes, size, page count, category, acquisition/license information, and expected outcomes. Create at least 200 manually reviewed selection/context cases spanning the PDF categories. Use synthetic fixtures for adversarial and geometric cases.

### Comparisons

1. PDF.js rendering and text extraction alone as the baseline.
2. PDF.js plus inspector WASM, separating cold initialization from warm calls.
3. Single-page versus 3-page, 5-page, and whole-document extraction.
4. Desktop Rust inspector versus browser WASM on the same source versions where available.
5. OpenDataLoader local mode only as a later challenger; report JVM startup separately.
6. OCR or hybrid modes only in separate experiments with their resource and network costs visible.

### Procedure

Pin app commit, parser/package versions, options, corpus hashes, hardware, browser, power mode, and network conditions. Run a smoke pass, then 20 measured iterations per representative fixture and condition. Report median, p95, worst case, failures, and raw samples. Randomize engine order and distinguish cold storage, warm assets, and warm semantic caches.

Measure end-to-end first-page readiness, WASM download/init, byte loading/copying, parser execution, normalization, persistence, lookup, navigation, and peak memory independently. Include a 20-minute scrolling session to reveal leaks. Test offline mode with network blocked and record all attempted requests.

For quality, score exact selected-text recovery, sentence boundaries, reading-order adjacency, incorrect cross-column joins, and abstentions. Initial gate: at least 95% correct context on ordinary native-text cases; no more than 1% wrong high-confidence contexts across the full labeled set. Report difficult-case coverage separately so abstaining on every hard page cannot masquerade as quality.

Classification accuracy is measured per page where ground truth exists. Do not interpret a document classification score as semantic alignment confidence.

### Decision outputs

Produce `results.json`, a concise benchmark report, traces for regressions, a capability/version manifest, and the chosen window/batch policy. Native vendor timings are contextual references only. The product's browser decision depends on these measurements, not a claimed universal parser speed ratio.

## 18. Security and privacy

### Trust boundaries

Treat books, dictionary downloads, parser output, AI output, imported backups, and external links as untrusted. Separate untrusted document content from the application origin and from native capabilities.

| Threat | Required control | Verification |
|---|---|---|
| EPUB/Markdown script execution | Sanitize; disable scripts/forms; isolate rendering | Malicious document fixtures execute no script |
| Remote tracking images/fonts | Block or rewrite external resources; self-host assets | Offline/no-egress trace while opening hostile content |
| ZIP/path attacks | Validate paths, expansion size, counts, ratios | Traversal and decompression-bomb fixtures rejected |
| Parser exhaustion | Size/output limits, bounded jobs, browser worker watchdog | Oversized/stalled input leaves UI usable |
| Malicious PDF actions | Disable active scripting and uncontrolled attachments/actions | Fixtures cannot execute or open destinations automatically |
| Unsafe links | Permit only supported schemes; require user activation | `javascript:`, file and custom schemes rejected |
| AI prompt injection | Quote source data; fixed task; no tools; validate output | Adversarial passages cannot trigger external actions |
| Credential leakage | No shared frontend secret; no secret storage in IndexedDB/logs | Bundle, storage, and log inspection |
| Native privilege abuse | Tauri capabilities and opaque file IDs | Untrusted frames cannot invoke commands |
| Supply-chain compromise | Lockfiles, pinned assets, integrity checks, review | Reproducible dependency/license inventory |

Start with a restrictive CSP: self-hosted scripts/assets, no `unsafe-eval`, limited workers, no remote document resources, and narrowly scoped AI destinations. Add only the WASM allowance and Blob/frame exceptions proven necessary by actual integration tests. An arbitrary endpoint picker conflicts with a fixed network allowlist; support vetted endpoints initially or route later custom endpoints through a separately secured transport.

Tauri distinguishes WebView code from native privileges. Restrict commands and file access through its capability model, and keep remote/document frames outside privileged contexts. [Tauri security model](https://v2.tauri.app/security/)

### Privacy contract

- No document uploads, telemetry, third-party analytics, or automatic AI calls by default.
- PWA asset/dictionary requests reveal ordinary network metadata to the hosting service; disclose this separately from document processing.
- AI opt-in explains destination, submitted excerpt, and the provider's applicable data handling before first use.
- Local databases and original books are not application-encrypted by default. Browser/OS access controls are not a promise of encryption against someone with device access.
- Provide delete document, delete derived caches, delete learning data, and reset all local data as distinct actions.
- Diagnostics contain versions, error codes, durations, and sizes only. Export is user initiated; exclude filenames, text, hashes, and secrets unless specifically reviewed.

For a later OpenDataLoader sidecar, pass arguments without shell interpolation, restrict input/output directories, bound output and runtime, clean temporary files, and keep hybrid/network modes off unless explicitly enabled. A local runtime must never silently route a document to a cloud service.

## 19. PWA and desktop delivery

### PWA

Ship an HTTPS static application with a manifest, install icons, and a service worker. Precache the shell; explicitly install PDF worker, WASM, fonts/CMaps required by the pinned build, and the selected dictionary pack before showing **Ready offline**.

Use versioned immutable assets and an atomic application cache manifest. Keep originals in IndexedDB, not service-worker response caches. Do not cache AI POST responses or credentials through the service worker.

Do not force a service-worker update during reading. Notify the user, persist current progress, and activate on an agreed reload. Keep old hashed assets available long enough for open tabs. Test offline deep links, interrupted installs, old/new worker combinations, and storage eviction. Browser installation UI varies; basic web use must work without installation.

### Tauri

Add Tauri after the PWA passes acceptance. Keep the same frontend and Dexie records initially; browser and desktop profiles are separate, with export/import as the transfer method. Do not imply automatic shared data.

Use the native inspector crate for semantic extraction and PDF.js for display. Bundle no Java runtime, OCR model, or OpenDataLoader by default. Add managed filesystem originals only if measurements justify leaving IndexedDB; version that transition and preserve a rollback/export path.

Build and test macOS first, then Windows and Linux according to actual demand. Sign/notarize applicable releases and protect update signing keys. A future updater verifies signed metadata and artifacts before installation. Each platform requires real WebView, selection, storage, and file-permission tests; browser success alone is insufficient.

## 20. Testing strategy

Use focused unit/integration tests with one standard test runner and browser end-to-end tests with Playwright. Native code uses Rust's existing test tooling. Avoid tests that merely duplicate data declarations.

| Layer | Required cases |
|---|---|
| Text normalization | Apostrophes, contractions, Unicode offsets, ligatures, preserved hyphens, ambiguous matches |
| Dictionary | Exact/alias/inflection hits, miss behavior, multiple senses, pack validation and interrupted activation |
| Parser adapter | Page numbering, missing markers, empty output, password error, schema drift, stale response |
| Reader | Zoom, rotation, crop boxes, virtualized selection, page restore, rapid navigation |
| Storage | Quota failure, aborted transaction, migration, duplicate import, multi-tab conflict, backup restore |
| Learning | Save/edit meaning, multiple occurrences, source deletion, review double tap, UTC scheduling |
| AI | Explicit opt-in, payload minimization, abort, timeout, malformed result, prompt injection, no key persistence |
| Security | Scripted EPUB, unsafe Markdown, remote resources, ZIP attacks, native command denial |
| PWA | Clean install, offline relaunch, deep link, partial asset download, update during active reading |

Golden tests should compare stable semantic facts, not every byte of a parser's Markdown. Pin geometry expectations only for controlled synthetic fixtures. Use real-browser IndexedDB tests in addition to fast storage mocks.

Automate desktop Chromium, Firefox, and WebKit journeys. Manually test native long-press selection and PWA lifecycle on Android and iOS. Test keyboard and screen-reader flows; automated accessibility scans supplement these checks.

Critical end-to-end journey: import a PDF, read the first page, select an unfamiliar word, see a local meaning, save it, close the application, relaunch offline, restore position, and review the word. Repeat the relevant journey for EPUB, TXT, and Markdown.

## 21. CI/CD and operations

### Pull-request checks

1. Install locked dependencies and verify formatting/types.
2. Run focused unit and integration tests.
3. Build the production bundle; record compressed shell and lazy-asset sizes.
4. Run critical browser journeys and malicious-content fixtures.
5. Check dependency advisories and licenses; block exploitable high/critical findings unless an explicit, time-bounded exception is documented.
6. Validate dictionary manifest, checksums, and notices when dictionary inputs change.
7. Run the small stable performance corpus; flag regressions over 15% and require controlled confirmation before blocking on noisy timings.

Nightly or release jobs run the full browser/corpus matrix, migration fixtures, offline/update tests, and desktop builds where supported. Use synthetic AI responses in CI. A separate opt-in provider smoke test uses short-lived test credentials and synthetic text only.

### Release pipeline

Create a versioned build from a tagged commit, publish a dependency/license inventory, retain benchmark results, and deploy to staging. Test headers, MIME types, WASM/worker paths, offline installation, and upgrades against production-like hosting.

Promote immutable artifacts after acceptance; do not rebuild different bytes for production. Retain the previous application assets for rollback. Database migrations require compatibility planning because rolling back static files cannot undo a schema change.

Desktop jobs build per OS, run native tests, sign packages, and publish checksums. Store signing secrets only in protected release environments.

### Operations without surveillance

Provide a local diagnostics panel with app/parser versions, cache sizes, capability results, and anonymized timings. Users may copy an issue report after reviewing it. Remote error collection remains off by default. Maintain a release checklist, dependency-update cadence, and documented vulnerability-reporting route.

## 22. Implementation phases

Estimates below are planning ranges for one experienced developer, excluding external reviews and provider approvals. Gates, not dates, determine readiness.

### Phase 0 — Feasibility and baseline: 3–5 working days

**Build:** Minimal PDF.js reader spike, inspector worker spike, package capability manifest, dictionary sample converter, baseline corpus, and transport proof for optional AI.

**Exit:** Confirm or explicitly reject every gate in Section 2. Record actual bundle sizes, first-page timings, memory, WASM output shape, and repeated-call costs. Freeze supported browser/device profiles and source licenses. Create ADRs 001–005.

### Phase 1 — Local reader foundation: 4–6 working days

**Build:** App shell, library, file validation, Dexie schema, PDF canvas/text layer, page navigation, appearance controls, progress restore, and temporary-session handling.

**Exit:** Standard PDF opens within the proposed tier; selection works; an IndexedDB failure does not lose the active session; originals and progress survive restart. No document network egress.

### Phase 2 — Semantic parsing and selection: 4–7 working days

**Build:** Inspector worker, normalization, page cache, request generations, timeouts, selected-page scheduling, classification warnings, text alignment, and PDF.js fallback.

**Exit:** Quality corpus meets alignment thresholds; stale jobs cannot update current UI; scanned pages remain readable; parser failure does not block selection or navigation. Record chosen batch/window policy.

### Phase 3 — Dictionary and vocabulary: 4–6 working days

**Build:** Licensed pack pipeline, atomic installation, indexed lookup, hover/touch/keyboard card, manual meaning entry, saved occurrences, vocabulary editing, basic review, and JSON/CSV export.

**Exit:** Offline lookup meets latency targets; coverage audit is documented; attribution ships; saved data survives reload and backup round trip. No AI request occurs on hover or miss.

### Phase 4 — Other formats and PWA: 4–6 working days

**Build:** EPUB, TXT, Markdown adapters; safe resource handling; format-native anchors; offline asset installation; install manifest; update flow; storage controls.

**Exit:** All four format journeys pass offline; hostile content is blocked; progress restores after typography changes; interrupted downloads retain working assets.

### Phase 5 — Optional AI: 2–4 working days

**Build:** One approved provider/transport, consent and payload preview, neutral Indonesian prompt, response validation, context-aware cache, abort/retry, and credential handling.

**Exit:** Real synthetic-text smoke test passes; disabling AI yields a complete offline experience; sensitive information is absent from logs/storage. No release dependency on a claimed free tier.

### Phase 6 — Hardening and v0.1 release: 3–5 working days

**Build:** Remaining accessibility corrections, cross-browser fixes, migration/backup recovery, production hosting, CI gates, notices, privacy copy, and release documentation.

**Exit:** All core release criteria in Section 24 have evidence. Publish known limitations and measured supported tiers. Total core estimate: approximately 24–39 working days, adjusted after Phase 0.

### Phase 7 — Scheduled review: 2–3 working days

**Build:** Fixed interval schedule, due queue, review events, idempotent grading, UTC/timezone handling, and simple local statistics.

**Exit:** Review state is reproducible from events; double actions do not duplicate grades; timezone changes do not unexpectedly reschedule cards.

### Phase 8 — Optional Tauri: 5–8 working days for first platform

**Build:** Desktop wrapper, constrained file picker, Rust semantic adapter, credential transport if needed, export/import transfer, packaging and signing.

**Exit:** Native/browser normalized-contract tests pass; first-platform installer works on a clean machine; no Java or OCR dependency is required for normal books.

### Phase 9 — Evidence-driven extensions: separately estimated

Evaluate OCR, OpenDataLoader, offline neural translation, or richer scheduling only against documented failures/user needs. Each extension gets a separate budget, privacy review, benchmark, and ADR. OpenDataLoader must improve a named difficult-document subset enough to justify runtime and maintenance costs.

## 23. Architecture decision records

Store these records in `docs/adr/` with date, status, context, decision, alternatives, consequences, evidence, and revisit trigger.

| ADR | Decision | Consequence and revisit trigger |
|---|---|---|
| 001 | PWA first; Tauri optional | Browser remains the baseline; revisit native-first only for demonstrated platform blockers |
| 002 | PDF.js owns rendering and selection | Semantic failures cannot stop reading; revisit only if visual/selection acceptance fails |
| 003 | Inspector is primary semantic parser | WASM in browser, Rust in desktop; availability remains gated by pinned-package tests |
| 004 | No assumed WASM positioned-text parity | Use text matching and PDF.js geometry; revisit when a released binding proves equivalent data |
| 005 | First-page display precedes enrichment | Hashing and full extraction stay off the critical path; revisit scheduling only through benchmarks |
| 006 | Dexie/IndexedDB owns local application data | No initial server or SQLite; revisit desktop file storage for measured quota/large-file problems |
| 007 | Dictionary before AI | Predictable offline lookup; contextual sense choice remains explicit |
| 008 | AI is optional and user initiated | No automatic cloud fallback; transport and credentials must pass their own gate |
| 009 | Canonical page/block text, Markdown only at boundaries | Parser formatting does not become the user-data schema |
| 010 | Quote-backed source anchors | More resilient than transient DOM offsets; ambiguous restoration is surfaced rather than guessed |
| 011 | Versioned derived caches | Parser changes reprocess pages without deleting learning records |
| 012 | Basic review before advanced scheduler | Initial review stays transparent; scheduled intervals arrive separately |
| 013 | OCR and OpenDataLoader deferred | No heavy runtime in the default bundle; add only for measured document coverage gains |
| 014 | No default telemetry or sync | User-owned backups are essential; any sync changes the privacy model and requires a new decision |

ADRs document this plan's decisions; they are not claims of implemented or benchmark-validated behavior.

## 24. Release acceptance criteria

Every checked item must link to a test result, benchmark, reviewed artifact, or manual verification record in the implementation repository.

### Core v0.1

- [ ] PDF, reflowable EPUB, TXT, and Markdown open from local files on supported profiles.
- [ ] PDF.js renders and supplies selectable text independently of inspector readiness.
- [ ] Inspector WASM runs in a worker as the primary semantic path on validated PDFs.
- [ ] Published package API behavior and limitations are recorded; no unsupported position API is assumed.
- [ ] Missing/failed semantic output falls back without corrupting selected text or inventing context.
- [ ] Page navigation, zoom, chapter navigation, and saved progress work after restart.
- [ ] Desktop hover, touch selection, and keyboard lookup all work with an installed dictionary.
- [ ] Dictionary source, notices, pack integrity, coverage sample, and no-match behavior are verified.
- [ ] Vocabulary preserves chosen meaning, context, provenance, and source location.
- [ ] Basic review, editing, deletion, and backup/restore work offline.
- [ ] First-page, lookup, save, bundle, and memory budgets pass on declared tiers or have explicit documented exceptions.
- [ ] Alignment meets the quality thresholds, including false-confidence limits and reported difficult-case coverage.
- [ ] Scanned, damaged, encrypted, unsupported, and oversized documents have actionable states.
- [ ] Quota failure never silently deletes user data or reports a failed write as saved.
- [ ] Offline readiness is verified by relaunch with network blocked, not only by a service-worker registration.
- [ ] Core reading/learning produces no document-content egress.
- [ ] AI, when configured, requires explicit activation and submits only reviewed bounded text.
- [ ] Security fixtures, accessibility checks, migration tests, and the production deployment smoke test pass.
- [ ] Privacy statement, license notices, limitations, backup guidance, and diagnostics are present.

### Later feature acceptance

- [ ] Scheduled review records grades once and restores due state correctly across timezone/restart changes.
- [ ] Tauri uses the Rust parser through constrained commands and passes shared contract fixtures.
- [ ] Desktop installer is signed as appropriate and verified on a clean supported machine.
- [ ] Any OCR/model download is explicit, separately sized, checksummed, and removable.
- [ ] OpenDataLoader is added only with demonstrated quality improvement, a managed runtime story, bounded execution, and no silent external processing.

## 25. Risks and open decisions

| Risk or decision | Default response | Closure evidence |
|---|---|---|
| Published WASM differs from current source | Pin and probe before designing against APIs | Capability manifest and contract tests |
| Whole-buffer parsing exhausts phone memory | Bound file tiers; defer semantics; reduce copies/concurrency | Real-device memory trace and graceful rejection |
| Repeated selected-page calls reload the document | Benchmark batches; cache completed pages | Per-call and end-to-end timing comparison |
| Semantic text cannot align reliably | Abstain and use exact selection | Labeled alignment corpus |
| Dictionary coverage is too weak | Improve licensed source/pack; keep manual meanings | Reviewed common-word and phrase sample |
| EPUB selection breaks under isolation | Validate iframe policy early; preserve security boundary | Real-browser hostile-content and selection tests |
| AI endpoint is unsuitable for static browsers | Use approved relay or Tauri transport; keep AI optional | Actual endpoint integration and credential audit |
| Browser data is evicted | Persistence request, visible storage state, backups | Eviction/quota recovery tests |
| Parser update changes text anchors | Preserve quote/native locator; mark ambiguous matches | Upgrade fixtures and restoration report |
| Mobile PDF selection is unreliable | Prioritize native controls; document supported browser tier | iOS/Android manual journey evidence |
| Desktop native job cannot be interrupted | Bound concurrency and discard results; isolate later if needed | Timeout behavior documented and tested |

Before implementation, Phase 0 must settle exact browser support, dependency versions, dictionary artifact/license handling, AI transport, and measured file-size tiers. These are implementation decisions with proposed defaults, not reasons to delay creating the core reader.

## 26. Source references

Primary technical references checked on 22 September 2026:

- [PDF.js project documentation](https://mozilla.github.io/pdf.js/) and [rendering examples](https://mozilla.github.io/pdf.js/examples/).
- [firecrawl/pdf-inspector repository](https://github.com/firecrawl/pdf-inspector).
- [Inspector browser/WASM documentation](https://github.com/firecrawl/pdf-inspector/blob/main/wasm/README.md).
- [Inspector WASM wrapper source](https://github.com/firecrawl/pdf-inspector/blob/main/wasm/src/lib.rs).
- [Inspector Rust API documentation](https://github.com/firecrawl/pdf-inspector/blob/main/docs/rust-api.md).
- [OpenDataLoader PDF repository](https://github.com/opendataloader-project/opendataloader-pdf).
- [Open DSL Wiktionary dictionary source](https://github.com/open-dsl-dict/wiktionary-dict).
- [epub.js repository and security guidance](https://github.com/futurepress/epub.js).
- [Dexie database design documentation](https://dexie.org/docs/Tutorial/Design).
- [MDN storage quotas and eviction](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria).
- [Tauri security documentation](https://v2.tauri.app/security/).

The architecture, schemas, limits, release phases, and acceptance budgets in this document are project proposals. Source links support dependency capabilities and constraints; they do not establish that the proposed application has passed its tests.
