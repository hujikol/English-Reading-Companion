import { describe, expect, it } from "vitest";
import { bundleGroup } from "../../src/pwa/offline-assets.build.ts";
import { BUDGET_BY_GROUP, DELIVERY_BUDGETS, toAssetManifest, type Inventory } from "../../src/pwa/offline-assets.ts";
import { computeReadiness } from "../../src/pwa/manifest.ts";

describe("optional local AI delivery", () => {
  it("accounts AI runtime bundles separately from lazy PDF engines", () => {
    const entry = new Set(["/assets/index-app.js", "/assets/webllm-shared.js"]);
    expect(bundleGroup("/assets/explain.worker-hash.js", entry)).toBe("optional-ai");
    expect(bundleGroup("/assets/explain-worker-hash.js", entry)).toBe("optional-ai");
    expect(bundleGroup("/assets/webllm-runtime.js", entry)).toBe("optional-ai");
    expect(bundleGroup("/assets/webllm-shared.js", entry)).toBe("shell");
    expect(bundleGroup("/assets/pdf.worker-hash.js", entry)).toBe("lazy-chunks");
    expect(BUDGET_BY_GROUP["optional-ai"]).toBe("offlineInstall");
    expect(DELIVERY_BUDGETS.pdfEngine).toBe(1.5 * 1024 * 1024);
  });

  it("keeps AI assets declared but allows offline reading without them", () => {
    const shell = { id: "shell", url: "/index.html", kind: "shell" as const, producer: "A" as const, version: "1", integrity: "sha384-AA", bytes: 1, required: true, group: "shell" as const };
    const optional = { ...shell, id: "optional-ai:qwen", url: "/models/qwen3-4b-webgpu.wasm", kind: "wasm" as const, group: "optional-ai" as const, required: false };
    const inventory: Inventory = { schema: 1, appVersion: "1", groups: [], totals: { files: 2, bytes: 2, gzipBytes: 2 }, assets: [shell, optional] };
    const manifest = toAssetManifest(inventory);
    expect(manifest.assets).toHaveLength(2);
    expect(computeReadiness(manifest, [{ id: shell.id, version: shell.version, integrity: shell.integrity, verified: true }]).readyOffline).toBe(true);
  });
});
