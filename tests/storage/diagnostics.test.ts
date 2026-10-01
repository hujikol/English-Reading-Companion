import { describe, expect, it } from "vitest";
import { computeReadiness } from "../../src/pwa/manifest.ts";
import {
  buildDiagnosticsReport,
  formatDiagnostics,
  type DiagnosticsInput,
} from "../../src/features/settings/diagnostics/report.ts";
import { breakdownByCategory, type TableSize } from "../../src/features/settings/storage/quota.ts";

const base: DiagnosticsInput = {
  appVersion: "0.1.0",
  contractVersion: "a0-contracts-1",
  databaseVersion: 1,
  parserVersion: "sem-1.0.0",
  userAgent: "Mozilla/5.0 (Macintosh) Chrome/120",
  persistentStorage: "granted",
  capabilities: { semantic: "inspector", password: true, ocr: false, positionedText: false },
  readiness: computeReadiness({ appVersion: "0.1.0", assets: [] }, []),
  installPhase: "ready-offline",
  storage: { used: 1_000_000, quota: 10_000_000 },
  categories: [],
};

/**
 * Poisoned the way real callers are: a leaked document record merged into the
 * input, a filename and a digest in a legitimate string field, and content-
 * shaped timing keys. Nothing here may reach the output.
 */
const POISON = {
  originalName: "War and Peace — secret edition.pdf",
  title: "The Quick Brown Fox Jumps Over The Lazy Dog",
  contentHash: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  apiKey: "sk-ant-0123456789abcdefghijklmnopqrstuvwxyz",
  quote: "In the beginning was the Word, and the Word was with God.",
  integrity: "sha384-oTI8mg9S8v3zRlk0k5+2UQ8VvPHqDc2P2wZ1l0mQzA5mI0bQ9xJ2V1cE4dS3fGh",
  blob: new Uint8Array([1, 2, 3]),
} as Record<string, unknown>;

describe("diagnostics report", () => {
  it("includes versions, capabilities, storage and timings", () => {
    const report = buildDiagnosticsReport({
      ...base,
      categories: [{ category: "originals", bytes: 800, canFree: false }],
      timingsMs: { "pdf.first-page": 120.4, "dict.lookup": 8 },
    });
    expect(report).toMatchObject({
      appVersion: "0.1.0",
      contractVersion: "a0-contracts-1",
      databaseVersion: 1,
      parserVersion: "sem-1.0.0",
      capabilities: { semantic: "inspector", password: "true", ocr: "false", positionedText: "false" },
      storage: { used: 1_000_000, quota: 10_000_000 },
    });
    expect(report.timingsMs).toEqual({ "pdf.first-page": 120, "dict.lookup": 8 });
    expect(report.offline.readyOffline).toBe(false);
    expect(report.platform.persistentStorage).toBe("granted");
  });

  it("excludes document text, filenames, hashes and secrets", () => {
    const report = buildDiagnosticsReport({
      ...base,
      ...(POISON as Partial<DiagnosticsInput>),
      capabilities: {
        ...base.capabilities,
        semantic: "fallback-only",
      } as DiagnosticsInput["capabilities"],
      timingsMs: {
        "pdf.first-page": 10,
        "mark.quote-text": 5,
        "hash.compute": 3,
        "api.response": 4,
        "book.open": 6,
      },
      storage: { used: 1, quota: 2 },
    });
    const text = formatDiagnostics(report);
    const serialized = JSON.stringify(report);

    expect(text).not.toContain("War and Peace");
    expect(serialized).not.toContain("War and Peace");
    expect(text).not.toContain(".pdf");
    expect(text).not.toContain("9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08");
    expect(text).not.toContain("sk-ant-0123456789abcdefghijklmnopqrstuvwxyz");
    expect(text).not.toContain("sha384-oTI8mg9S8v3zRlk0k5");
    expect(text).not.toContain("In the beginning was the Word");
    expect(text).not.toContain("Quick Brown Fox");

    // Content-shaped timing keys are dropped, legitimate ones survive.
    expect(Object.keys(report.timingsMs)).toEqual(["pdf.first-page"]);
  });

  it("drops unknown input properties entirely", () => {
    const report = buildDiagnosticsReport({ ...base, ...POISON } as DiagnosticsInput);
    expect(Object.keys(report)).toEqual([
      "appVersion",
      "contractVersion",
      "databaseVersion",
      "parserVersion",
      "platform",
      "capabilities",
      "offline",
      "storage",
      "timingsMs",
    ]);
  });

  it("redacts a digest leaked through a legitimate version field", () => {
    const report = buildDiagnosticsReport({
      ...base,
      appVersion: "9f86d081884c7d659a2feaa0c55ad015",
    });
    expect(report.appVersion).toBe("[redacted]");
  });

  it("keeps capability flags that are legitimately false", () => {
    expect(buildDiagnosticsReport(base).capabilities.positionedText).toBe("false");
  });

  it("carries the storage breakdown with its freeable flags", () => {
    const sizes: TableSize[] = [
      { table: "documents", bytes: 900, category: "originals" },
      { table: "semanticPages", bytes: 100, category: "derived-pages" },
    ];
    const report = buildDiagnosticsReport({ ...base, categories: breakdownByCategory(sizes) });
    expect(report.storage.byCategory).toEqual([
      { category: "derived-pages", bytes: 100, canFree: true },
      { category: "originals", bytes: 900, canFree: false },
    ]);
    expect(formatDiagnostics(report)).toContain("originals: 900 bytes (cannot free user data)");
  });

  it("ignores negative and non-numeric timings", () => {
    const report = buildDiagnosticsReport({ ...base, timingsMs: { a: -1, b: Number.NaN } });
    expect(report.timingsMs).toEqual({});
  });
});