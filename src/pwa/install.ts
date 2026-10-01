/**
 * Install state machine. Section 19: interrupted installs retain the previous
 * working version, no forced update during reading, activation only on an
 * agreed reload. Pure reducer; the service worker and UI supply the events.
 *
 * `phase` describes the install attempt, not offline capability. What actually
 * works offline is always re-derived with computeReadiness().
 */

import type { Readiness } from "./manifest.ts";

export type InstallPhase =
  | "idle"
  | "installing"
  | "partial"
  | "ready-offline"
  | "update-available"
  | "failed";

export type InstallState = {
  phase: InstallPhase;
  /** Version that is known to work offline. Never cleared by a failure. */
  activeVersion: string | null;
  /** Version being installed, or offered as an update, not yet activated. */
  pendingVersion: string | null;
  reading: boolean;
  reloadAgreed: boolean;
  lastError: string | null;
};

export const initialInstallState: InstallState = {
  phase: "idle",
  activeVersion: null,
  pendingVersion: null,
  reading: false,
  reloadAgreed: false,
  lastError: null,
};

export type InstallEvent =
  | { type: "start"; version: string }
  | { type: "status"; readiness: Readiness }
  | { type: "interrupt"; reason?: string }
  | { type: "fail"; reason: string }
  | { type: "retry" }
  | { type: "found-update"; version: string }
  | { type: "agree-reload" }
  | { type: "reject-update" }
  | { type: "activated"; version: string }
  | { type: "reading-changed"; reading: boolean };

export function reduceInstall(state: InstallState, event: InstallEvent): InstallState {
  switch (event.type) {
    case "start":
      // A previous working version stays active while the new one installs.
      return { ...state, phase: "installing", pendingVersion: event.version, reloadAgreed: false, lastError: null };

    case "status": {
      if (event.readiness.readyOffline) {
        return {
          ...state,
          phase: "ready-offline",
          activeVersion: state.pendingVersion ?? state.activeVersion,
          pendingVersion: null,
          reloadAgreed: false,
          lastError: null,
        };
      }
      const incomplete =
        event.readiness.missing.length + event.readiness.mismatched.length + event.readiness.unverified.length > 0;
      return { ...state, phase: incomplete ? "partial" : state.phase };
    }

    case "interrupt":
      // Never loses the working version. With no working version an interrupted
      // install is, by definition, not offline-ready.
      return {
        ...state,
        phase: state.activeVersion !== null ? "ready-offline" : "partial",
        lastError: event.reason ?? "install interrupted",
        reloadAgreed: false,
      };

    case "fail":
      return { ...state, phase: "failed", lastError: event.reason, reloadAgreed: false };

    case "retry":
      if (state.pendingVersion === null) return state;
      return { ...state, phase: "installing", lastError: null, reloadAgreed: false };

    case "found-update":
      if (state.phase === "installing") return { ...state, pendingVersion: event.version };
      // Reading: offer later, do not disturb the session.
      return { ...state, pendingVersion: event.version, phase: state.reading ? state.phase : "update-available" };

    case "agree-reload":
      // Ignored unless an update is actually pending: updates are never forced.
      if (state.phase !== "update-available") return state;
      return { ...state, phase: "installing", reloadAgreed: true };

    case "reject-update":
      if (state.phase !== "update-available") return state;
      return {
        ...state,
        phase: state.activeVersion !== null ? "ready-offline" : "idle",
        pendingVersion: null,
        reloadAgreed: false,
      };

    case "activated":
      return {
        ...state,
        phase: "ready-offline",
        activeVersion: event.version,
        pendingVersion: null,
        reloadAgreed: false,
        lastError: null,
      };

    case "reading-changed":
      return { ...state, reading: event.reading };
  }
}