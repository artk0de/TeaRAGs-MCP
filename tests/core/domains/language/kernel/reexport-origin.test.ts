import { describe, expect, it } from "vitest";

import type {
  CallContext,
  GlobalSymbolTable,
  SymbolDefinition,
} from "../../../../../src/core/contracts/types/codegraph.js";
import { reexportOriginFile } from "../../../../../src/core/domains/language/kernel/reexport-origin.js";

const def = (name: string, relPath: string): SymbolDefinition => ({
  symbolId: `${relPath}::${name}`,
  fqName: name,
  shortName: name,
  relPath,
  scope: [],
});

/** Minimal in-test GlobalSymbolTable: the hop only reads `lookup`. */
const tableWith = (declarations: Record<string, SymbolDefinition[]>): GlobalSymbolTable => ({
  upsertFile: () => undefined,
  removeFile: () => undefined,
  lookup: (name) => declarations[name] ?? [],
  lookupByShortName: (name) => declarations[name] ?? [],
  hasFile: () => false,
  hasFilesUnder: () => false,
  size: () => Object.values(declarations).reduce((a, defs) => a + defs.length, 0),
  hydrate: () => undefined,
  shortNameDefCounts: () => new Map(Object.entries(declarations).map(([n, defs]) => [n, defs.length])),
});

const ctxWith = (declarations: Record<string, SymbolDefinition[]>): CallContext => ({
  callerFile: "app/caller.ts",
  callerScope: [],
  imports: [],
  symbolTable: tableWith(declarations),
});

describe("reexportOriginFile", () => {
  it("declines a name the symbol table does not know", () => {
    expect(reexportOriginFile("Button", "ui-kit/index.ts", ctxWith({}), "strict")).toBeNull();
  });

  it("declines when the imported file declares the name itself — not a re-export hop", () => {
    const ctx = ctxWith({ Button: [def("Button", "ui-kit/index.ts")] });
    expect(reexportOriginFile("Button", "ui-kit/index.ts", ctx, "strict")).toBeNull();
  });

  it("follows the barrel to the single file that declares the name", () => {
    const ctx = ctxWith({ Button: [def("Button", "ui-kit/components/Button/Button.tsx")] });
    expect(reexportOriginFile("Button", "ui-kit/index.ts", ctx, "strict")).toBe("ui-kit/components/Button/Button.tsx");
  });

  it("narrows an ambiguous global answer to the barrel's own package (bd tea-rags-mcp-ex28m)", () => {
    const ctx = ctxWith({
      Button: [def("Button", "ui-kit/components/Button/Button.tsx"), def("Button", "legacy/Button.tsx")],
    });
    expect(reexportOriginFile("Button", "ui-kit/index.ts", ctx, "strict")).toBe("ui-kit/components/Button/Button.tsx");
  });

  it("does not let a package claim a sibling sharing its directory prefix", () => {
    const ctx = ctxWith({
      Button: [def("Button", "ui-kit-legacy/Button.tsx"), def("Button", "legacy/Button.tsx")],
    });
    expect(reexportOriginFile("Button", "ui-kit/index.ts", ctx, "strict")).toBeNull();
  });

  it("still declines when two candidates live inside the barrel's own package", () => {
    const ctx = ctxWith({
      Button: [def("Button", "ui-kit/a/Button.tsx"), def("Button", "ui-kit/b/Button.tsx")],
    });
    expect(reexportOriginFile("Button", "ui-kit/index.ts", ctx, "strict")).toBeNull();
  });

  it("declines when a root-level barrel has no package directory to narrow against", () => {
    const ctx = ctxWith({ Button: [def("Button", "a/Button.tsx"), def("Button", "b/Button.tsx")] });
    expect(reexportOriginFile("Button", "index.ts", ctx, "strict")).toBeNull();
  });

  it("legacy `first` mode picks the first candidate and never reaches the package retry", () => {
    const ctx = ctxWith({
      Button: [def("Button", "legacy/Button.tsx"), def("Button", "ui-kit/components/Button.tsx")],
    });
    expect(reexportOriginFile("Button", "ui-kit/index.ts", ctx, "first")).toBe("legacy/Button.tsx");
  });
});
