# Known limitations

The active reader uses selectable text for PDF, EPUB, TXT and Markdown. It supports one-page reading, lazy continuous scrolling, local dictionary lookup, saved highlights and explicit online translation.

## Reader and language limits

- Scanned PDFs need OCR. Complex columns and poor embedded text can produce incorrect reading order or spelling. Dictionary-assisted fragment repair is conservative and does not replace OCR.
- Text mode omits document images and original print layouts. EPUB content remains validated and sanitized before text extraction.
- The dictionary has incomplete coverage. Ambiguous inflections are presented as candidates; missing words remain explicit misses.
- MyMemory translation requires internet access, sends only the requested selection or sentence, and limits requests to 500 UTF-8 bytes. Provider availability and quotas can prevent translation.
- Local contextual explanations require WebGPU, about 2.3 GB of model storage and approximately 3.4 GB of GPU memory. Browser cache eviction can require a new download. AI suggestions may misinterpret context; model readiness is separate from core offline reading readiness.

## Delivery verification limits

The build verifies asset inventory, digests and size budgets. The offline smoke test checks service-worker policy against simulated cache storage. Browser offline relaunch, installation across browser engines, and production hosting headers still need separate release verification.

## 5. Benchmarks: only delivery budgets are measured

Section 16 defines performance budgets and Section 17 defines a benchmark
plan. **Only the delivery-budget half is implemented**, because that is the
half measurable from build output in CI:

- shell JS gzip, total shell transfer, lazy PDF engine, inspector WASM,
  total offline install — enforced by `assertBudgets()` in
  `src/pwa/offline-assets.build.ts` and asserted in `tests/pwa/offline.test.ts`.

Not implemented, and deliberately not faked:

- Section 17's corpus (30+ documents, 200+ labelled selection/context cases).
- First readable PDF page, reopen latency, local lookup, semantic context,
  save-vocabulary and selection-response budgets.
- Memory measurement, 20-minute scrolling leak session, device/browser matrix.
- The 15% regression flagging Section 21 asks for.

The `benchmark-smoke` CI job runs the delivery-budget check and **only** that.
Its job name says "benchmark smoke (delivery budgets)" so a green run cannot be
read as "the performance budgets passed".

---

## 6. npm audit: 5 dev-only advisories, deferred

`npm audit` reports **5 findings**, all in the development toolchain, none in
shipped application code:

| Package | Severity | Reachable by |
| --- | --- | --- |
| `vitest` | critical | local test server / Vitest UI |
| `vite` | high | local dev server, Windows-only UNC path handling |
| `@vitest/mocker` | moderate | redirect mock, dev only |
| `vite-node` | moderate | dev only |
| `esbuild` | moderate | dev server request handling |

Verified: `npm audit --omit=dev` reports **0** production vulnerabilities. None
of these packages are bundled into `dist/`; they run only on a developer's
machine.

**Recommended fix is a breaking upgrade: `vite` 8.3.2 and `vitest` 5.0.3.**
Both are major bumps that will require changing `vite.config.ts`, the vitest
setup and the build scripts.

**Recommendation: defer until the test suite is stable.** Reasons, in order:

1. The suite is still being written by several tracks in parallel. A major
   vitest bump changes the runner every one of those tests depends on; doing it
   now means resolving upgrade noise and feature work in the same diff.
2. The exposure is a local development server. It is not reachable by a user of
   the deployed app.
3. The upgrade is not free: vite 8 changes the build API and vitest 5 changes
   the mocking and environment APIs that the existing tests use.

**Reconsider immediately if** any of these become true: the app ships a hosted
dev/preview server; a contributor-facing preview URL is exposed; or track A
opens the desktop work, which changes the build toolchain anyway.

This is the "explicit, time-bounded exception" Section 21 requires. It is
recorded here, enforced in `.github/workflows/ci.yml` (production audit blocks,
dev audit reports without blocking), and should be revisited before any release.