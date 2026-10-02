/**
 * Inspector extraction benchmark. Run with:
 *
 *   npx tsx scripts/benchmarks/inspector.ts        (if tsx is available)
 *   node --experimental-strip-types scripts/benchmarks/inspector.ts
 *
 * WHAT IT MEASURES, and why each column exists:
 *
 *   - `classify` — parse-only cost, no markdown conversion. The routing hint
 *     the reader pays on open.
 *   - `whole`    — one `processPdf` over every page with page markers on. The
 *     "complete this small document" path.
 *   - `window:n` — a bounded window request, which is what the app actually
 *     does: visible page plus two each side. This is the number the Section 16
 *     budget "semantic context for visible page" has to be judged against.
 *   - `perPage`  — one upstream call per page. The fallback cost, and the
 *     worst case for a document with an empty page in the window.
 *
 * TIMING HONESTY. Every `processPdf` call is SYNCHRONOUS and blocks. There is
 * no warm-up-free first call: the first call pays WASM linear-memory growth and
 * page-cache population. So each measurement is run `repeats` times and BOTH the
 * median and the min are reported — the min is the steady-state cost and the
 * median is what a user experiences, and quoting only the min would flatter the
 * parser. The first (cold) iteration is reported separately rather than
 * averaged away, because a cold open is a separate Section 16 budget line.
 *
 * CORRECTNESS IS ASSERTED, NOT ASSUMED. Every run verifies that the extracted
 * page count matches, that no page came back empty, and that page indexes are
 * consecutive and ascending. A throughput number for a run that silently
 * mis-associated pages would be worthless, so a failed assertion exits non-zero.
 *
 * These are SYNTHETIC documents (see ./corpus.ts). Real books with embedded
 * font programs, multi-column layouts and tables parse considerably slower, so
 * treat the per-page figures as a floor.
 */

import { loadInspectorEngine, isWasmReady } from "../../src/document/wasm/index.ts";
import { createAdapter, extractPages } from "../../src/document/adapter.ts";
import { PAGE_MARKER_OPTION, toUpstreamPages } from "../../src/document/pageSplit.ts";
import { semanticWindow, DESKTOP_RADIUS } from "../../src/document/jobs.ts";
import type { InspectorEngine } from "../../src/document/types.ts";
import { CORPUS, buildCorpusPdf } from "./corpus.ts";

const REPEATS = 5;

type Stat = { min: number; median: number; max: number };

/** Min/median/max of a sample. Median, because one slow GC must not be the mean. */
const stat = (samples: number[]): Stat => {
  const s = [...samples].sort((a, b) => a - b);
  const at = (q: number): number => s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
  return { min: s[0]!, median: at(0.5), max: s[s.length - 1]! };
};

const ms = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${n.toFixed(1)} ms`);

/** Time a call, returning elapsed wall-clock ms. The call is synchronous. */
const time = (fn: () => void): number => {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
};

const main = async (): Promise<void> => {
  const engine: InspectorEngine = await loadInspectorEngine();
  if (!isWasmReady()) throw new Error("WASM reported not ready after init");
  console.log(`inspector-wasm version: ${engine.version()}`);
  console.log(`node: ${process.version}  platform: ${process.platform}/${process.arch}`);
  console.log(`repeats per measurement: ${REPEATS} (min/median/max reported)\n`);

  let failures = 0;

  for (const spec of CORPUS) {
    const bytes = buildCorpusPdf(spec);
    const adapter = createAdapter(engine, { bytes, pageCount: spec.pages });

    // --- classification (parse only, no markdown) ---
    const coldClassify = time(() => void engine.classifyPdf(bytes));
    const classifySamples = Array.from({ length: REPEATS }, () => time(() => void engine.classifyPdf(bytes)));
    const classification = engine.classifyPdf(bytes);

    // --- whole document, markers on ---
    const coldWhole = time(() => void engine.processPdf(bytes, { ...PAGE_MARKER_OPTION }));
    const wholeSamples = Array.from({ length: REPEATS }, () =>
      time(() => void engine.processPdf(bytes, { ...PAGE_MARKER_OPTION })),
    );

    // --- the app's real path: a bounded window, through the adapter ---
    const visible = Math.floor(spec.pages / 2);
    const windowPages = semanticWindow({ visiblePageIndex: visible, pageCount: spec.pages, radius: DESKTOP_RADIUS });
    const coldWindow = time(() => void extractPages(adapter, windowPages));
    const windowSamples = Array.from({ length: REPEATS }, () => time(() => void extractPages(adapter, windowPages)));

    // --- the fallback worst case: one upstream call per page ---
    const singlePages = windowPages;
    const perPageSamples = Array.from({ length: REPEATS }, () =>
      time(() => {
        for (const p of singlePages) {
          void engine.processPdf(bytes, { ...PAGE_MARKER_OPTION, pages: toUpstreamPages([p]) });
        }
      }),
    );

    // --- CORRECTNESS GATE ---
    const whole = extractPages(adapter, Array.from({ length: spec.pages }, (_, i) => i));
    const problems: string[] = [];
    if (!whole.ok) {
      problems.push(`whole-document extraction failed: ${whole.message ?? whole.kind}`);
    } else {
      const got = whole.pages.map((p) => p.pageIndex);
      const expected = Array.from({ length: spec.pages }, (_, i) => i);
      if (got.join(",") !== expected.join(",")) problems.push(`page indexes wrong: ${got.join(",")}`);
      const empty = whole.pages.filter((p) => p.text.length === 0);
      if (empty.length > 0) problems.push(`${empty.length} page(s) extracted empty text`);
    }
    if (classification.pageCount !== spec.pages)
      problems.push(`classify pageCount ${classification.pageCount} != ${spec.pages}`);

    const cs = stat(classifySamples);
    const ws = stat(wholeSamples);
    const wins = stat(windowSamples);
    const ps = stat(perPageSamples);
    const windowTotalPages = windowPages.length;

    console.log(`=== ${spec.name} — ${spec.pages} pages, ${(bytes.length / 1024).toFixed(1)} KiB, ${spec.paragraphs} paragraphs/page ===`);
    console.log(`  classify  (parse only)  min ${ms(cs.min).padEnd(9)} med ${ms(cs.median).padEnd(9)} max ${ms(cs.max).padEnd(9)}  ${(spec.pages / (cs.median / 1000)).toFixed(0)} pages/s`);
    console.log(`  whole doc (all pages)    min ${ms(ws.min).padEnd(9)} med ${ms(ws.median).padEnd(9)} max ${ms(ws.max).padEnd(9)}  ${(spec.pages / (ws.median / 1000)).toFixed(0)} pages/s  ${((ws.median) / spec.pages).toFixed(2)} ms/page`);
    console.log(`  window ${windowTotalPages}p (r=${DESKTOP_RADIUS})       min ${ms(wins.min).padEnd(9)} med ${ms(wins.median).padEnd(9)} max ${ms(wins.max).padEnd(9)}  ${(windowTotalPages / (wins.median / 1000)).toFixed(0)} pages/s  ${(wins.median / windowTotalPages).toFixed(2)} ms/page`);
    console.log(`  per-page (${windowTotalPages} calls)      min ${ms(ps.min).padEnd(9)} med ${ms(ps.median).padEnd(9)} max ${ms(ps.max).padEnd(9)}  ${(windowTotalPages / (ps.median / 1000)).toFixed(0)} pages/s  ${(ps.median / windowTotalPages).toFixed(2)} ms/page`);
    console.log(`  cold first call: classify ${ms(coldClassify)}, whole ${ms(coldWhole)}, window ${ms(coldWindow)}`);
    const totalChars = whole.ok ? whole.pages.reduce((n, p) => n + p.text.length, 0) : 0;
    if (whole.ok) {
      console.log(`  extracted ${totalChars} chars of text; median whole-doc throughput ${(totalChars / (ws.median / 1000) / 1024).toFixed(1)} KiB/s`);
    }

    if (problems.length > 0) {
      failures++;
      console.log(`  CORRECTNESS FAILED: ${problems.join("; ")}`);
    } else {
      console.log(`  correctness: OK (${spec.pages} pages, none empty, indexes consecutive)`);
    }
    console.log("");
  }

  if (failures > 0) {
    console.error(`FAILED: ${failures} corpus document(s) did not pass the correctness gate.`);
    process.exitCode = 1;
  } else {
    console.log("All corpus documents passed the correctness gate. Throughput numbers above are real.");
  }
};

await main();
