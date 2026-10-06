/**
 * Service-worker registration and the offline-readiness claim. Section 19.
 *
 * This module is the ONLY place that can produce the string "Ready offline",
 * and it cannot produce it on its own:
 *
 *   1. It fetches the build inventory (dist/offline-assets.json), which records
 *      a byte count and a sha384 digest for every precached file.
 *   2. It asks the service worker what is actually in its cache.
 *   3. It hands both to computeReadiness() — the existing, tested policy in
 *      ./manifest.ts — which reports ready only when every REQUIRED asset is
 *      installed, digest-verified and at the manifest version.
 *   4. It hands that readiness to reduceInstall() — ./install.ts — which owns
 *      the phases and refuses to activate an update the user has not agreed to.
 *
 * Consequence: caching the shell is not enough. An empty or absent install
 * report yields a readiness with every required asset missing, and the phase
 * stays "partial". There is no code path that reaches "ready-offline" from
 * shell caching alone.
 */

import { computeReadiness, type AssetManifest, type InstalledAsset, type Readiness } from "./manifest.ts";
import { initialInstallState, reduceInstall, type InstallState } from "./install.ts";
import { INVENTORY_URL, SW_SCOPE, SW_URL, parseInventory, toAssetManifest, type Inventory } from "./offline-assets.ts";
import { recoverFromQuota } from "../features/settings/storage/quota.ts";
import { isEvictable, type TableName } from "../contracts/index.ts";

/** Shape written by the service worker after a precache pass. */
export type InstallReport = {
  appVersion: string;
  cacheName: string;
  installed: readonly InstalledAsset[];
  errors: readonly { url: string; reason: string }[];
  verifiedBytes: number;
} | null;

export type OfflineStatus = {
  /** False when the browser has no service worker: basic web use must still work. */
  supported: boolean;
  readiness: Readiness;
  install: InstallState;
  totals: { files: number; bytes: number; verifiedBytes: number };
  errors: readonly { url: string; reason: string }[];
  inventory: Inventory | null;
};

export type OfflineController = {
  status(): OfflineStatus;
  subscribe(listener: (status: OfflineStatus) => void): () => void;
  refresh(): Promise<OfflineStatus>;
  /** Re-run precache after a quota failure. Never deletes user data. */
  retry(): Promise<OfflineStatus>;
  /** The user agreed to reload: activate the waiting worker. */
  agreeReload(): void;
  rejectUpdate(): void;
  /** Tells the install machine not to disturb an active reading session. */
  setReading(reading: boolean): void;
  destroy(): void;
};

export type RegisterOptions = {
  /**
   * Called with the tables quota recovery proposes to evict. The tables come
   * from the durability contract, never from a list written here, and the
   * callback is handed only `derived` tables — see evictDerivedOnly().
   */
  evictDerived?: (tables: readonly TableName[]) => Promise<void>;
};

const nothingReady = (manifest: AssetManifest, reason: string): OfflineStatus => ({
  supported: false,
  readiness: computeReadiness(manifest, []),
  install: reduceInstall(initialInstallState, { type: "fail", reason }),
  totals: { files: 0, bytes: 0, verifiedBytes: 0 },
  errors: [],
  inventory: null,
});

/**
 * Last line of defence for Section 13 ("never automatically delete
 * vocabulary, marks, explanations, or original files"). recoverFromQuota()
 * already filters through the durability contract; this re-checks the list at
 * the moment of eviction so a future caller cannot pass a user table through
 * by mistake.
 */
export async function evictDerivedOnly(
  tables: readonly TableName[],
  evict: (tables: readonly TableName[]) => Promise<void>,
): Promise<void> {
  const safe = tables.filter((table) => isEvictable(table));
  if (safe.length === 0) return;
  await evict(safe);
}

async function fetchInventory(): Promise<Inventory | null> {
  try {
    const response = await fetch(INVENTORY_URL, { cache: "no-store", credentials: "omit" });
    if (!response.ok) return null;
    return parseInventory(await response.json());
  } catch {
    return null;
  }
}

function askWorker(worker: ServiceWorker, message: unknown, timeoutMs = 20_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => reject(new Error("service worker did not reply")), timeoutMs);
    channel.port1.onmessage = (event: MessageEvent) => {
      clearTimeout(timer);
      resolve(event.data);
    };
    worker.postMessage(message, [channel.port2]);
  });
}

async function readReport(registration: ServiceWorkerRegistration): Promise<InstallReport> {
  const worker = registration.active ?? registration.waiting ?? registration.installing;
  if (!worker) return null;
  const reply = (await askWorker(worker, { type: "erc:status" })) as { report?: InstallReport } | null;
  return reply?.report ?? null;
}

/**
 * Register the worker and wire it to the existing install state machine.
 * Resolves even when service workers are unavailable; callers get a status
 * whose readiness can never be true, so the app still runs as a plain site.
 */
export async function registerServiceWorker(options: RegisterOptions = {}): Promise<OfflineController> {
  const listeners = new Set<(status: OfflineStatus) => void>();
  let install: InstallState = initialInstallState;
  let readiness: Readiness | null = null;
  let inventory: Inventory | null = null;
  let manifest: AssetManifest = { appVersion: "0.0.0", assets: [] };
  let report: InstallReport = null;
  let lastError: string | null = null;

  const publish = (): void => {
    const status: OfflineStatus = {
      supported: readiness !== null,
      readiness: readiness ?? computeReadiness(manifest, []),
      install,
      totals: {
        files: inventory?.totals.files ?? 0,
        bytes: inventory?.totals.bytes ?? 0,
        verifiedBytes: report?.verifiedBytes ?? 0,
      },
      errors: report?.errors ?? [],
      inventory,
    };
    for (const listener of listeners) listener(status);
  };

  const send = (event: Parameters<typeof reduceInstall>[1]): void => {
    install = reduceInstall(install, event);
    publish();
  };

  const evaluate = (): void => {
    if (inventory === null) return;
    manifest = toAssetManifest(inventory);
    // THE claim. computeReadiness over the build inventory and the digests the
    // worker re-read out of its own cache.
    readiness = computeReadiness(manifest, report?.installed ?? []);
    install = reduceInstall(install, { type: "status", readiness });
    publish();
  };

  const refresh = async (): Promise<OfflineStatus> => {
    if (!("serviceWorker" in navigator)) return nothingReady(manifest, "service workers unsupported");
    inventory = await fetchInventory();
    if (inventory === null) {
      readiness = computeReadiness(manifest, []);
      send({ type: "fail", reason: "offline asset inventory unavailable" });
      return { supported: false, readiness, install, totals: { files: 0, bytes: 0, verifiedBytes: 0 }, errors: [], inventory: null };
    }
    manifest = toAssetManifest(inventory);
    send({ type: "start", version: inventory.appVersion });
    try {
      const registration = await navigator.serviceWorker.getRegistration(SW_SCOPE);
      report = registration ? await readReport(registration) : null;
      lastError = null;
      evaluate();
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      send({ type: "fail", reason: lastError });
    }
    return { supported: true, readiness: readiness!, install, totals: { files: inventory.totals.files, bytes: inventory.totals.bytes, verifiedBytes: report?.verifiedBytes ?? 0 }, errors: report?.errors ?? [], inventory };
  };

  if (!("serviceWorker" in navigator)) {
    const status = nothingReady(manifest, "service workers unsupported");
    install = status.install;
    return {
      status: () => status,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      refresh: async () => status,
      retry: async () => status,
      agreeReload: () => undefined,
      rejectUpdate: () => undefined,
      setReading: (reading) => send({ type: "reading-changed", reading }),
      destroy: () => listeners.clear(),
    };
  }

  const registration = await navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE, updateViaCache: "none" });

  registration.addEventListener("updatefound", () => {
    const installing = registration.installing;
    if (!installing) return;
    installing.addEventListener("statechange", () => {
      // An update never activates by itself. reduceInstall keeps the phase
      // quiet while `reading` is true and only offers "update-available"
      // otherwise (Section 19).
      if (installing.state === "installed") send({ type: "found-update", version: inventory?.appVersion ?? "unknown" });
      if (installing.state === "activated") send({ type: "activated", version: inventory?.appVersion ?? "unknown" });
    });
  });

  const precacheRetry = async (): Promise<OfflineStatus> => {
    const registrationNow = await navigator.serviceWorker.getRegistration(SW_SCOPE);
    const worker = registrationNow?.active;
    if (worker === null || worker === undefined) return refresh();

    // Quota policy comes from the tested recovery path, not from here: evict
    // derived tables, retry once, and if it still fails keep the session
    // temporary rather than touching a single user record.
    const sizes = [
      { table: "semanticPages" as const, bytes: 0, category: "derived-pages" as const },
      { table: "aiCache" as const, bytes: 0, category: "ai-cache" as const },
    ];
    const { outcome } = await recoverFromQuota(
      async () => {
        const reply = (await askWorker(worker, { type: "erc:reinstall" })) as { report?: InstallReport };
        if (!reply.report) throw new Error("precache returned no report");
        report = reply.report;
        return reply.report;
      },
      sizes,
      async (tables) => {
        if (options.evictDerived) await evictDerivedOnly(tables, options.evictDerived);
      },
    );

    if (outcome.status === "temporary-session") {
      readiness = computeReadiness(manifest, report?.installed ?? []);
      send({ type: "fail", reason: "storage full: offline install could not complete" });
      return { supported: true, readiness, install, totals: { files: inventory?.totals.files ?? 0, bytes: inventory?.totals.bytes ?? 0, verifiedBytes: report?.verifiedBytes ?? 0 }, errors: report?.errors ?? [], inventory };
    }
    if (outcome.status === "ok-after-eviction") {
      lastError = null;
      evaluate();
    }
    return { supported: true, readiness: readiness!, install, totals: { files: inventory?.totals.files ?? 0, bytes: inventory?.totals.bytes ?? 0, verifiedBytes: report?.verifiedBytes ?? 0 }, errors: report?.errors ?? [], inventory };
  };

  await refresh();

  return {
    status: () => ({
      supported: readiness !== null,
      readiness: readiness ?? computeReadiness(manifest, []),
      install,
      totals: { files: inventory?.totals.files ?? 0, bytes: inventory?.totals.bytes ?? 0, verifiedBytes: report?.verifiedBytes ?? 0 },
      errors: report?.errors ?? [],
      inventory,
    }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh,
    retry: async () => (lastError === null ? refresh() : precacheRetry()),
    agreeReload: () => {
      send({ type: "agree-reload" });
      const worker = registration.waiting;
      if (worker) worker.postMessage({ type: "erc:skip-waiting" });
    },
    rejectUpdate: () => send({ type: "reject-update" }),
    setReading: (reading) => send({ type: "reading-changed", reading }),
    destroy: () => listeners.clear(),
  };
}