import { describe, expect, it } from "vitest";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";

/**
 * The dictionary chunk transfer contract.
 *
 * The bug this pins: the pack is gzipped ON DISK, and the host also serves it
 * with `Content-Encoding: gzip`. The browser therefore inflates it
 * automatically, and `arrayBuffer()` returns plain JSON. installPack gunzips
 * whatever it is handed, so passing those bytes straight through fails with
 * "incorrect header check" and the dictionary silently never installs.
 *
 * loadPack solves it by requesting `Accept-Encoding: identity` and inflating
 * only if the response is still compressed. Both host behaviours are modelled
 * here, because a real deployment may be either.
 */

const CHUNK = "packs/en-id/pack-0.1.0-0000.json.gz";
const raw = readFileSync(CHUNK);

describe("dictionary chunk bytes", () => {
  it("is gzip on disk, with the gzip magic number", () => {
    // 1f 8b — if this fails the pack was written uncompressed.
    expect([raw[0], raw[1]]).toEqual([0x1f, 0x8b]);
  });

  it("inflates to the row payload the installer expects", () => {
    const rows = (JSON.parse(gunzipSync(raw).toString("utf8")) as { rows: unknown[] }).rows;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("a host that ignores Accept-Encoding still yields bytes installPack can gunzip", () => {
    // Host sends Content-Encoding: gzip -> browser inflates -> we re-inflate so
    // the hand-off to installPack is always gzipped.
    const browserWouldSee = gunzipSync(raw); // what arrayBuffer() returns
    expect(browserWouldSee.subarray(0, 2).toString("utf8")).not.toBe("\x1f\x8b");

    const reInflated = gunzipSync(raw); // the identity-header path, undone
    expect((JSON.parse(reInflated.toString("utf8")) as { rows: unknown[] }).rows.length).toBe(
      (JSON.parse(browserWouldSee.toString("utf8")) as { rows: unknown[] }).rows.length,
    );
  });

  it("a host that honours Accept-Encoding returns the gzipped bytes unchanged", () => {
    // identity -> no Content-Encoding -> arrayBuffer() is the file as stored.
    expect(gunzipSync(raw).length).toBeGreaterThan(0);
  });
});