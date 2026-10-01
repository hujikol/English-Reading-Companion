import { describe, expect, it } from "vitest";
import { computeReadiness, type AssetEntry, type AssetManifest } from "../../src/pwa/manifest.ts";

const asset = (over: Partial<AssetEntry> & Pick<AssetEntry, "id">): AssetEntry => ({
  url: `/assets/${over.id}`,
  kind: "shell",
  producer: "B",
  version: "1",
  integrity: `sha384-${over.id}AAAA`,
  bytes: 100,
  required: true,
  ...over,
});

const manifest = (assets: AssetEntry[]): AssetManifest => ({ appVersion: "0.1.0", assets });

const shell = asset({ id: "shell.js", kind: "shell", producer: "B" });
const worker = asset({ id: "pdf.worker.js", kind: "pdf-worker", producer: "B" });
const cmap = asset({ id: "cmap.bcmap", kind: "cmap", producer: "B" });
const dict = asset({ id: "dict-en.pack", kind: "dictionary", producer: "C" });

const installed = (list: AssetEntry[]) =>
  list.map((a) => ({ id: a.id, version: a.version, integrity: a.integrity, verified: true }));

describe("offline readiness", () => {
  it("is ready only when every required asset is installed, verified and version-matched", () => {
    const m = manifest([shell, worker, cmap, dict]);
    const r = computeReadiness(m, installed([shell, worker, cmap, dict]));
    expect(r.readyOffline).toBe(true);
    expect(r.requiredCount).toBe(4);
  });

  it("is not ready from shell caching alone", () => {
    const m = manifest([shell, worker, cmap, dict]);
    const r = computeReadiness(m, installed([shell]));
    expect(r.readyOffline).toBe(false);
    expect([...r.missing].sort()).toEqual(["cmap.bcmap", "dict-en.pack", "pdf.worker.js"]);
  });

  it("names the specific assets missing from a partial install", () => {
    const m = manifest([shell, worker, cmap, dict]);
    const r = computeReadiness(m, installed([shell, worker]));
    expect(r.missing).toEqual(["cmap.bcmap", "dict-en.pack"]);
    expect(r.mismatched).toEqual([]);
    expect(r.unverified).toEqual([]);
  });

  it("rejects a stale asset version even when the file is present and verified", () => {
    const m = manifest([shell, worker, cmap]);
    const stale = installed([{ ...shell, version: "0" }, worker, cmap]);
    const r = computeReadiness(m, stale);
    expect(r.readyOffline).toBe(false);
    expect(r.mismatched).toEqual(["shell.js"]);
    expect(r.missing).toEqual([]);
  });

  it("rejects a same-version asset whose digest does not match", () => {
    const m = manifest([shell, worker]);
    const wrongBytes = [{ ...installed([shell])[0]!, integrity: "sha384-different" }, installed([worker])[0]!];
    expect(computeReadiness(m, wrongBytes).mismatched).toEqual(["shell.js"]);
  });

  it("separates unverified from mismatched so a re-verify can be retried", () => {
    const m = manifest([shell, dict]);
    const r = computeReadiness(m, [{ ...installed([shell])[0]!, verified: false }, installed([dict])[0]!]);
    expect(r.unverified).toEqual(["shell.js"]);
    expect(r.mismatched).toEqual([]);
    expect(r.readyOffline).toBe(false);
  });

  it("ignores optional assets but still reports them as not installed", () => {
    const optional = asset({ id: "dict-de.pack", required: false, producer: "C" });
    const r = computeReadiness(manifest([shell, optional]), installed([shell]));
    expect(r.readyOffline).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.requiredCount).toBe(1);
  });

  it("never claims ready when the manifest requires nothing", () => {
    // Guard against a mis-built manifest turning empty into "Ready offline".
    expect(computeReadiness(manifest([]), []).readyOffline).toBe(false);
  });

  it("ignores extra installed assets outside the manifest", () => {
    const m = manifest([shell]);
    const r = computeReadiness(m, [...installed([shell]), { id: "stale-old.js", version: "1", integrity: "sha384-x", verified: true }]);
    expect(r.readyOffline).toBe(true);
    expect(r.missing).toEqual([]);
  });
});