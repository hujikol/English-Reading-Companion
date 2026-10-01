import { describe, expect, it } from "vitest";
import {
  initialInstallState,
  reduceInstall,
  type InstallState,
} from "../../src/pwa/install.ts";
import type { Readiness } from "../../src/pwa/manifest.ts";

const READY: Readiness = { readyOffline: true, missing: [], mismatched: [], unverified: [], requiredCount: 3 };
const PARTIAL: Readiness = { readyOffline: false, missing: ["dict.pack"], mismatched: [], unverified: [], requiredCount: 3 };

const run = (state: InstallState, ...events: Parameters<typeof reduceInstall>[1][]): InstallState =>
  events.reduce(reduceInstall, state);

const READY_V1 = run(initialInstallState, { type: "start", version: "1.0.0" }, { type: "status", readiness: READY });

describe("install state machine", () => {
  it("starts idle and reaches ready-offline only on full readiness", () => {
    expect(initialInstallState.phase).toBe("idle");
    expect(run(initialInstallState, { type: "start", version: "1.0.0" }).phase).toBe("installing");
    expect(run(initialInstallState, { type: "start", version: "1.0.0" }, { type: "status", readiness: PARTIAL }).phase).toBe("partial");
    expect(READY_V1).toMatchObject({ phase: "ready-offline", activeVersion: "1.0.0", pendingVersion: null });
  });

  it("keeps the previous working version when an install is interrupted", () => {
    const s = run(READY_V1, { type: "start", version: "2.0.0" }, { type: "interrupt", reason: "network lost" });
    expect(s).toMatchObject({ phase: "ready-offline", activeVersion: "1.0.0", pendingVersion: "2.0.0" });
    expect(s.lastError).toBe("network lost");
  });

  it("is not offline-ready after an interrupted first install", () => {
    const s = run(initialInstallState, { type: "start", version: "1.0.0" }, { type: "interrupt" });
    expect(s.phase).toBe("partial");
    expect(s.activeVersion).toBeNull();
  });

  it("retries after an interruption and succeeds", () => {
    const s = run(
      initialInstallState,
      { type: "start", version: "1.0.0" },
      { type: "interrupt", reason: "closed tab" },
      { type: "retry" },
      { type: "status", readiness: READY },
    );
    expect(s).toMatchObject({ phase: "ready-offline", activeVersion: "1.0.0", lastError: null });
  });

  it("ignores a retry with nothing pending", () => {
    expect(reduceInstall(READY_V1, { type: "retry" })).toBe(READY_V1);
  });

  it("never forces an update during reading", () => {
    const reading = { ...READY_V1, reading: true };
    const s = reduceInstall(reading, { type: "found-update", version: "2.0.0" });
    expect(s.phase).toBe("ready-offline");
    expect(s.pendingVersion).toBe("2.0.0");
    expect(reduceInstall(s, { type: "agree-reload" })).toBe(s);
  });

  it("offers an update when not reading, and applies it only after agreed reload", () => {
    const s = run(READY_V1, { type: "found-update", version: "2.0.0" });
    expect(s.phase).toBe("update-available");
    expect(reduceInstall(s, { type: "agree-reload" })).toMatchObject({ phase: "installing", reloadAgreed: true, activeVersion: "1.0.0" });
    const done = run(s, { type: "agree-reload" }, { type: "activated", version: "2.0.0" });
    expect(done).toMatchObject({ phase: "ready-offline", activeVersion: "2.0.0", pendingVersion: null });
  });

  it("keeps the old version when the user declines an update", () => {
    const declined = run(READY_V1, { type: "found-update", version: "2.0.0" }, { type: "reject-update" });
    expect(declined).toMatchObject({ phase: "ready-offline", activeVersion: "1.0.0", pendingVersion: null });
  });

  it("records failure without discarding the working version", () => {
    const s = run(READY_V1, { type: "start", version: "2.0.0" }, { type: "fail", reason: "integrity mismatch" });
    expect(s).toMatchObject({ phase: "failed", activeVersion: "1.0.0", lastError: "integrity mismatch" });
  });

  it("rejects an agreed reload when no update is pending", () => {
    expect(reduceInstall(READY_V1, { type: "agree-reload" })).toBe(READY_V1);
    expect(reduceInstall(initialInstallState, { type: "reject-update" })).toBe(initialInstallState);
  });
});