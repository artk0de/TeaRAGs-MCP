/**
 * The factory is the single source of truth for the Python chain
 * (bd tea-rags-mcp-3yxmy). Both offline harnesses used to keep hand-copied
 * arrays, and when `importedName` landed at index 4 the jedi oracle's copy was
 * left behind — its own `chainDrift` guard fired on 117 flask sites and 552
 * ugnest sites and every number it printed was void.
 *
 * So this test does NOT assert a literal list of names as the harnesses did:
 * a second literal is a second thing to forget. It asserts the factory equals
 * what `PythonCallResolver` actually composes, which is the property the
 * harnesses depend on. The literal below is a readability anchor for the
 * production order, checked against the resolver in the same file.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type CallRef,
  type RelPath,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import type {
  ImportFileTarget,
  SymbolResolutionStrategy,
} from "../../../../../../src/core/contracts/types/language.js";
import { createPythonSymbolResolutionChain } from "../../../../../../src/core/domains/language/python/resolver/index.js";
import { PythonImportFileMapper } from "../../../../../../src/core/domains/language/python/resolver/python-import-file-mapper.js";
import { PythonCallResolver } from "../../../../../../src/core/domains/language/python/resolver/python-resolver.js";
import { CONE_MAX_DEFAULT } from "../../../../../../src/core/domains/language/python/resolver/strategies/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const cfg = { mode: DEFAULT_AMBIGUOUS_RESOLVE_MODE, coneMax: CONE_MAX_DEFAULT };

const PRODUCTION_ORDER = [
  "super",
  "selfField",
  "selfMember",
  "localBinding",
  "chainType",
  "namingConvention",
  "importedName",
  "globalShortName",
];

describe("createPythonSymbolResolutionChain", () => {
  it("composes exactly the chain PythonCallResolver runs — drift here voids every harness number", () => {
    expect(createPythonSymbolResolutionChain(cfg).map((pass) => pass.name)).toEqual(
      new PythonCallResolver().strategies.map((pass) => pass.name),
    );
  });

  it("keeps the production order, importedName the last import-consulting pass", () => {
    expect(new PythonCallResolver().strategies.map((pass) => pass.name)).toEqual(PRODUCTION_ORDER);
  });

  it("places chainType directly after localBinding — the seam-3 insertion point", () => {
    const names = createPythonSymbolResolutionChain(cfg).map((pass) => pass.name);
    expect(names.indexOf("chainType")).toBe(names.indexOf("localBinding") + 1);
  });

  /**
   * bd tea-rags-mcp-0g8g5 — `namingConvention` is the one GUESS in the chain.
   * After `chainType` so every typed channel answers first; before
   * `importedName` so a guess never preempts a binding the walker recorded.
   */
  it("places namingConvention between chainType and importedName — the seam-5 insertion point", () => {
    const names = createPythonSymbolResolutionChain(cfg).map((pass) => pass.name);
    expect(names.indexOf("namingConvention")).toBe(names.indexOf("chainType") + 1);
    expect(names.indexOf("importedName")).toBe(names.indexOf("namingConvention") + 1);
  });

  it("builds a fresh chain per call so two harness runs share no per-pass state", () => {
    const first = createPythonSymbolResolutionChain(cfg);
    const second = createPythonSymbolResolutionChain(cfg);
    expect(first[0]).not.toBe(second[0]);
  });

  it("accepts the caller's import-file mapper so the resolver's memo stays shared", () => {
    const mapper = new PythonImportFileMapper();
    expect(createPythonSymbolResolutionChain(cfg, mapper).map((pass) => pass.name)).toEqual(PRODUCTION_ORDER);
  });

  it("exposes the resolver's chain as a read-only view, not the array itself", () => {
    const resolver = new PythonCallResolver();
    expect(resolver.strategies).toBe(resolver.strategies);
    expect(resolver.strategies.length).toBe(PRODUCTION_ORDER.length);
  });
});

/**
 * bd tea-rags-mcp-6uptm (AF.7) — `selfField` asks the same import question the
 * rest of the chain does (`pythonTypeNameIsExternal`), so it has to read the
 * same memo. AF.6 gave it a DEFAULTED private mapper because the factory was
 * off limits then; the factory now hands its own instance in.
 *
 * Discriminated by VERDICT rather than by reaching into the strategy: the
 * recording mapper calls `app.models` external where the real one calls it
 * `project`, so only a `selfField` reading THAT instance can DROP.
 */
class RecordingImportFileMapper extends PythonImportFileMapper {
  readonly calls: string[] = [];

  override mapImportToFile(importText: string, fromFile: RelPath, ctx: CallContext): ImportFileTarget {
    this.calls.push(importText);
    return importText === "app.models" ? { kind: "external" } : super.mapImportToFile(importText, fromFile, ctx);
  }
}

const selfFieldCall: CallRef = {
  callText: "self.model.greet()",
  receiver: "self.model",
  member: "greet",
  startLine: 3,
};

/** `Foo` comes from a real project file, so the REAL mapper answers `project`. */
function selfFieldCtx(): CallContext {
  const table = new InMemoryGlobalSymbolTable();
  table.upsertFile("app/models.py", [
    { symbolId: "Foo", fqName: "Foo", shortName: "Foo", relPath: "app/models.py", scope: [] },
  ]);
  return {
    callerFile: "app/handler.py",
    callerScope: ["Handler"],
    imports: [{ importText: "app.models", startLine: 1, importedNames: ["Foo"], importedBindings: { Foo: "Foo" } }],
    classFieldTypes: { Handler: { model: "Foo" } },
    symbolTable: table,
  };
}

const selfFieldOf = (chain: SymbolResolutionStrategy[]): SymbolResolutionStrategy => {
  const pass = chain.find((candidate) => candidate.name === "selfField");
  if (!pass) throw new Error("chain has no selfField pass");
  return pass;
};

describe("createPythonSymbolResolutionChain — selfField shares the caller's mapper", () => {
  it("hands the injected mapper to selfField, whose external verdict then DROPS the call", () => {
    const mapper = new RecordingImportFileMapper();
    const outcome = selfFieldOf(createPythonSymbolResolutionChain(cfg, mapper)).attempt(selfFieldCall, selfFieldCtx());
    expect(outcome.kind).toBe("drop");
    expect(mapper.calls).toContain("app.models");
  });

  it("keeps the defaulted mapper when none is passed — the same call CONTINUEs on the real verdict", () => {
    expect(selfFieldOf(createPythonSymbolResolutionChain(cfg)).attempt(selfFieldCall, selfFieldCtx()).kind).toBe(
      "continue",
    );
  });
});
