/**
 * readPayloadImportSpecifiers (bd tea-rags-mcp-rbnkp): the module specifiers a
 * file declares, read off ONE of its stored chunks — every chunk of a file
 * carries the same `payload.imports` — through the index-served exact match on
 * `relativePath`.
 */
import { describe, expect, it, vi } from "vitest";

import { readPayloadImportSpecifiers } from "../../../../../src/core/api/internal/infra/payload-import-specifier-reader.js";

describe("readPayloadImportSpecifiers", () => {
  it("reads each file's imports from one chunk, leaving out files with none or unknown to the index", async () => {
    const stored: Record<string, Record<string, unknown>> = {
      "app/Editor.tsx": { imports: ["react", "./Editor.module.css"] },
      "app/NoImports.tsx": {},
    };
    const scrollFiltered = vi.fn(
      async (_collection: string, filter: { must: { key: string; match: { value?: string } }[] }) => {
        const relPath = filter.must.find((c) => c.match.value !== undefined)?.match.value ?? "";
        return relPath in stored ? [{ id: relPath, payload: stored[relPath] }] : [];
      },
    );

    const specifiers = await readPayloadImportSpecifiers({ scrollFiltered }, "code_x", [
      "app/Editor.tsx",
      "app/NoImports.tsx",
      "app/Missing.tsx",
    ]);

    expect(specifiers).toEqual(new Map([["app/Editor.tsx", ["react", "./Editor.module.css"]]]));
    expect(scrollFiltered).toHaveBeenCalledWith(
      "code_x",
      {
        must: [
          { key: "relativePath", match: { text: "app/Editor.tsx" } },
          { key: "relativePath", match: { value: "app/Editor.tsx" } },
        ],
      },
      1,
      1,
      ["imports"],
    );
  });

  it("reads nothing for no files", async () => {
    const scrollFiltered = vi.fn();

    expect(await readPayloadImportSpecifiers({ scrollFiltered }, "code_x", [])).toEqual(new Map());
    expect(scrollFiltered).not.toHaveBeenCalled();
  });
});
