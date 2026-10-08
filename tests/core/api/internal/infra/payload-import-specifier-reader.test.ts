/**
 * readPayloadImportSpecifiers (bd tea-rags-mcp-rbnkp): the module specifiers a
 * file declares, read off ONE of its stored chunks — every chunk of a file
 * carries the same `payload.imports` — through the index-served exact match on
 * `relativePath`.
 */
import { describe, expect, it, vi } from "vitest";

import {
  readPayloadImportSpecifiers,
  readPayloadIndexedFileImports,
} from "../../../../../src/core/api/internal/infra/payload-import-specifier-reader.js";

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

describe("readPayloadIndexedFileImports (bd tea-rags-mcp-89k7k.35.3)", () => {
  it("reads every file's imports once, flagging a test by the query path's one 'is a test' definition", async () => {
    const pages = [
      [
        { id: 1, payload: { relativePath: "app/specs/A.spec.tsx", isTest: true, imports: ["./A.spec.presets"] } },
        { id: 2, payload: { relativePath: "app/specs/A.spec.tsx", isTest: true, imports: ["./A.spec.presets"] } },
        {
          id: 3,
          payload: {
            relativePath: "tests/__helpers__/h.ts",
            imports: ["../src/x"],
            codegraph: { symbols: { file: { skippedAs: "test" } } },
          },
        },
      ],
      [
        { id: 4, payload: { relativePath: "app/__generated__/client.ts", imports: ["../api/helper"] } },
        { id: 5, payload: { relativePath: "app/NoImports.ts", imports: [] } },
        { id: 6, payload: { imports: ["./orphan"] } },
      ],
    ];
    const scrollPayloadPages = vi.fn(async function* () {
      yield* pages;
    });

    const files = await readPayloadIndexedFileImports({ scrollPayloadPages }, "code_x");

    expect(files).toEqual(
      new Map([
        ["app/specs/A.spec.tsx", { isTest: true, specifiers: ["./A.spec.presets"] }],
        ["tests/__helpers__/h.ts", { isTest: true, specifiers: ["../src/x"] }],
        ["app/__generated__/client.ts", { isTest: false, specifiers: ["../api/helper"] }],
      ]),
    );
    expect(scrollPayloadPages).toHaveBeenCalledWith("code_x", [
      "relativePath",
      "imports",
      "isTest",
      "codegraph.symbols.file.skippedAs",
    ]);
  });
});
