/**
 * `.mts` / `.cts` are TypeScript (bd tea-rags-mcp-1y13c). The import mappers
 * name them as targets — `"./worker.mts"`, and `"./esm.mjs"` under NodeNext —
 * but the walk had no `CODEGRAPH_LANGUAGES` row for either, so the target never
 * got a file row and the edge dangled. Both parse with the `typescript` grammar
 * (neither admits JSX) and walk with the TypeScript walker.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import ignore from "ignore";
import { afterAll, describe, expect, it } from "vitest";

import { LanguageFactory } from "../../../../../../src/core/domains/language/index.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import {
  CODEGRAPH_LANGUAGE_BY_EXTENSION,
  CodegraphFileExtractor,
} from "../../../../../../src/core/domains/trajectory/codegraph/symbols/file-extractor.js";
import { CodegraphPhaseTimings } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/phase-timings.js";
import { CodegraphRunState } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/run-state.js";

describe("CodegraphFileExtractor .mts / .cts (bd tea-rags-mcp-1y13c)", () => {
  const root = mkdtempSync(join(tmpdir(), "cg-esm-cjs-ts-"));
  mkdirSync(join(root, "src"), { recursive: true });
  const source = [
    'import { helper } from "./helper.mts";',
    "export class Pool {",
    "  run(): number {",
    "    return helper();",
    "  }",
    "}",
    "export function start(): Pool {",
    "  return new Pool();",
    "}",
    "",
  ].join("\n");
  writeFileSync(join(root, "src", "worker.mts"), source);
  writeFileSync(join(root, "src", "legacy.cts"), source);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const extractor = new CodegraphFileExtractor({
    languageFactory: new LanguageFactory(),
    collectSymbols,
    composer: new DefaultSymbolIdComposer(),
    runState: new CodegraphRunState(),
    phaseTimings: new CodegraphPhaseTimings(),
    exclusionFilter: ignore(),
  });

  it("walks both extensions as TypeScript", () => {
    expect(CODEGRAPH_LANGUAGE_BY_EXTENSION[".mts"]).toBe("typescript");
    expect(CODEGRAPH_LANGUAGE_BY_EXTENSION[".cts"]).toBe("typescript");
    expect(extractor.isExtractable("src/worker.mts")).toBe(true);
    expect(extractor.isExtractable("src/legacy.cts")).toBe(true);
    expect(extractor.discover(root).sort()).toEqual(["src/legacy.cts", "src/worker.mts"]);
  });

  it.each(["src/worker.mts", "src/legacy.cts"])("extracts the symbols, calls and imports of %s", (relPath) => {
    const extraction = extractor.extract(root, relPath);
    expect(extraction.language).toBe("typescript");
    expect(extraction.chunks.map((chunk) => chunk.symbolId)).toEqual(
      expect.arrayContaining(["Pool", "Pool#run", "start"]),
    );
    expect(extraction.imports.map((imp) => imp.importText)).toEqual(["./helper.mts"]);
    const run = extraction.chunks.find((chunk) => chunk.symbolId === "Pool#run");
    expect(run?.calls.map((call) => call.member)).toContain("helper");
  });
});
