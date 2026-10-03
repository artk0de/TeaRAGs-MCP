/**
 * The dense floor embeds a working tree's delta rows with the provider of the
 * BASE INDEX they are ranked against (bd tea-rags-mcp-b91f5): a delta row's
 * vector is compared with that index's stored vectors, so it must come from the
 * model that built them — the collection's registry model, not the serving
 * process's default.
 */
import { describe, expect, it, vi } from "vitest";

import { codeRow } from "../__fixtures__/working-tree-view.js";
import { WorkingTreeDenseVectorSource } from "../../../../../src/core/domains/explore/working-tree/dense-floor.js";

function provider(model: string, vector: number[]) {
  return {
    getModel: () => model,
    embedBatch: vi.fn(async (texts: string[]) => texts.map(() => ({ embedding: vector, dimensions: vector.length }))),
  };
}

const row = codeRow("t-new", { relativePath: "src/a.ts", content: "brand new body" });

describe("WorkingTreeDenseVectorSource — per-collection provider", () => {
  it("embeds each base index's delta rows with that index's provider", async () => {
    const ambient = provider("ambient", [1, 0]);
    const muninn = provider("muninn", [0, 1]);
    const coderank = provider("coderank", [0.5, 0.5]);
    const byCollection: Record<string, typeof ambient> = { code_tea: muninn, code_pix: coderank };
    const source = new WorkingTreeDenseVectorSource({
      embeddings: ambient,
      embeddingsForCollection: async (collectionName) => byCollection[collectionName] ?? ambient,
    });

    const tea = await source.warm({ collectionName: "code_tea", rows: [row] })(2_000);
    const pix = await source.warm({ collectionName: "code_pix", rows: [row] })(2_000);

    expect(tea.vectors.get("t-new")).toEqual([0, 1]);
    expect(pix.vectors.get("t-new")).toEqual([0.5, 0.5]);
    expect(ambient.embedBatch).not.toHaveBeenCalled();
  });

  it("reports a provider that cannot be resolved as the reader's failure, never a throw", async () => {
    const source = new WorkingTreeDenseVectorSource({
      embeddings: provider("ambient", [1, 0]),
      embeddingsForCollection: async () => {
        throw new TypeError("provider for code_pix could not start");
      },
    });

    const read = await source.warm({ collectionName: "code_pix", rows: [row] })(2_000);

    expect(read.vectors.size).toBe(0);
    expect(read.pending).toBe(1);
    expect(read.failure).toContain("could not start");
  });
});
