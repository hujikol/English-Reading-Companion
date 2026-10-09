import { describe, expect, it } from "vitest";
import { db } from "../../../src/db/index.ts";
import type { Explanation } from "../../../src/contracts/learning.ts";
import { saveSelection, type Selection } from "../../../src/ui/vocab/selectionPopover.ts";

const selection: Selection = {
  surface: "bank", sentence: "They sat on the river bank.", titleSnapshot: "Reading", documentId: "doc-1",
  anchor: { quote: "bank", prefix: "river ", suffix: ".", locator: { kind: "pdf", pageIndex: 0, pageFraction: 0 }, anchorState: "resolved", resolvedAt: 1 },
  rect: { top: 0, bottom: 10, left: 0, right: 40 },
};

const explanation: Omit<Explanation, "surface" | "createdAt"> = {
  id: "explanation-1", requestHash: "test-context", contextText: selection.sentence,
  provider: "local", model: "Qwen3", promptVersion: "v1",
  result: { naturalTranslation: "Mereka duduk di tepi sungai.", contextualMeaning: "tepi sungai", provider: "local", model: "Qwen3", promptVersion: "v1" },
};

describe("first-save meaning provenance", () => {
  it("preserves edited AI provenance and original explanation in durable rows", async () => {
    const outcome = await saveSelection({
      store: db, selection, meaning: "tepian di sepanjang sungai",
      provenance: { kind: "ai", sourceVersion: "local/Qwen3/v1", userEdited: true }, explanation,
    });
    expect(outcome.kind).toBe("saved");
    const row = (await db.vocabulary.toArray())[0]!;
    expect(row.meaning).toBe("tepian di sepanjang sungai");
    expect(row.provenance).toMatchObject({ kind: "ai", sourceVersion: "local/Qwen3/v1", userEdited: true });
    expect(row.explanationText).toBe("Mereka duduk di tepi sungai.\ntepi sungai");
    expect((await db.explanations.get(explanation.id))?.result).toEqual(explanation.result);
  });

  it("keeps distinct snapshots of the same request", async () => {
    await saveSelection({ store: db, selection, meaning: "tepi", explanation });
    await saveSelection({ store: db, selection, meaning: "tepian", explanation: { ...explanation, id: "explanation-2" } });
    expect(await db.explanations.where("requestHash").equals(explanation.requestHash).count()).toBe(2);
  });

  it("saves a dictionary choice without an AI explanation snapshot", async () => {
    const outcome = await saveSelection({ store: db, selection, meaning: "tepi", provenance: { kind: "dictionary", sourceVersion: "en-id-0.2.0" } });
    expect(outcome.kind).toBe("saved");
    const row = (await db.vocabulary.toArray())[0]!;
    expect(row.provenance).toMatchObject({ kind: "dictionary", sourceVersion: "en-id-0.2.0", userEdited: false });
    expect(row.explanationText).toBeUndefined();
    expect(await db.explanations.count()).toBe(0);
  });
});
