/**
 * Asset imports through `TSCallResolver` (bd tea-rags-mcp-unt4v). An import
 * whose as-written path names an existing non-source file — a CSS module, an
 * image — is not a project file: it yields no file edge (the file graph holds
 * code files only), and a call on its binding is EXTERNAL, relative specifier
 * or not, exactly like a call into an npm package.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { CallContext, FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { TSCallResolver } from "../../../../../../src/core/domains/language/typescript/resolver/ts-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

describe("TSCallResolver asset imports (bd tea-rags-mcp-unt4v)", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "ts-asset-import-"));
  mkdirSync(join(repoRoot, "src", "assets"), { recursive: true });
  writeFileSync(join(repoRoot, "src", "Button.module.css"), ".root {}\n");
  writeFileSync(join(repoRoot, "src", "assets", "logo.svg"), "<svg/>\n");
  writeFileSync(join(repoRoot, "src", "theme.ts"), "export const theme = {};\n");

  afterAll(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const resolver = new TSCallResolver({ baseUrl: ".", paths: {} }, "strict", repoRoot);
  const imports = [
    { importText: "./Button.module.css", startLine: 1, importedNames: ["styles"] },
    { importText: "./assets/logo.svg", startLine: 2, importedNames: ["Logo"] },
    { importText: "./theme", startLine: 3, importedNames: ["theme"] },
  ];
  const ctx: CallContext = {
    callerFile: "src/Button.tsx",
    callerScope: [],
    imports,
    symbolTable: new InMemoryGlobalSymbolTable(),
  };

  it("emits a file edge for the source import only, none for the assets", () => {
    const extraction: FileExtraction = {
      relPath: "src/Button.tsx",
      language: "typescript",
      imports,
      chunks: [],
      fileScope: [],
    };
    expect(resolver.resolveFileEdges(extraction, ctx)).toEqual([
      { targetRelPath: "src/theme.ts", importText: "./theme" },
    ]);
  });

  it("classifies a call on an asset import's binding as external", () => {
    expect(
      resolver.targetsExternalImport(
        { callText: "styles.compose()", receiver: "styles", member: "compose", startLine: 5 },
        ctx,
      ),
    ).toBe(true);
    expect(
      resolver.targetsExternalImport({ callText: "Logo()", receiver: null, member: "Logo", startLine: 6 }, ctx),
    ).toBe(true);
  });

  it("keeps a call on a source import's binding internal", () => {
    expect(
      resolver.targetsExternalImport(
        { callText: "theme.apply()", receiver: "theme", member: "apply", startLine: 7 },
        ctx,
      ),
    ).toBe(false);
  });
});
