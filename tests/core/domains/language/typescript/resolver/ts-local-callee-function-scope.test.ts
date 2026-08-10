import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type CallRef,
  type NamedSymbol,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import {
  TSGlobalShortNameSymbolResolutionStrategy,
  type ResolverConfig,
} from "../../../../../../src/core/domains/language/typescript/resolver/strategies/index.js";
import { TSProgramCache } from "../../../../../../src/core/domains/language/typescript/resolver/ts-program-cache.js";
import { TSCallResolver } from "../../../../../../src/core/domains/language/typescript/resolver/ts-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const tsOptions = { baseUrl: ".", paths: {} };
const cfg: ResolverConfig = { tsOptions, mode: DEFAULT_AMBIGUOUS_RESOLVE_MODE };

function writeSource(repoRoot: string, relPath: string, content: string): void {
  const abs = join(repoRoot, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

/** A dependency, declared where `TSProgramCache.isProjectSourceFile` draws the line. */
function writePackage(repoRoot: string, name: string, declarations: string[]): void {
  writeSource(
    repoRoot,
    `node_modules/${name}/package.json`,
    JSON.stringify({ name, version: "1.0.0", types: "index.d.ts" }),
  );
  writeSource(repoRoot, `node_modules/${name}/index.d.ts`, declarations.join("\n"));
}

const sym = (symbolId: string, shortName: string, relPath: string, scope: string[]): NamedSymbol => ({
  symbolId,
  fqName: symbolId,
  shortName,
  relPath,
  scope,
});

/**
 * Exactly ONE project symbol per colliding short name, built per test rather than
 * shared. Cardinality is load-bearing here: `globalShortName` only commits when
 * `pickSingleCandidate` sees a single candidate, so a table carrying two
 * `handler`s would make every assertion below pass for the wrong reason.
 */
const tableOf = (...symbols: { relPath: string; symbol: NamedSymbol }[]): InMemoryGlobalSymbolTable => {
  const built = new InMemoryGlobalSymbolTable();
  for (const { relPath, symbol } of symbols) built.upsertFile(relPath, [symbol]);
  return built;
};

const ctx = (callerFile: string, symbolTable: InMemoryGlobalSymbolTable): CallContext => ({
  callerFile,
  callerScope: [],
  imports: [],
  symbolTable,
});

/**
 * A callback declared as a FUNCTION-SCOPED `const` and invoked bare. Neither a
 * parameter nor a binding element, so bd tea-rags-mcp-5tatv's predicate did not
 * recognise it and `handler(id)` reached `globalShortName` free to land on an
 * unrelated project `Panel#handler`.
 */
function writeFunctionScopedCallbackFixture(repoRoot: string): void {
  writeSource(
    repoRoot,
    "src/renderer.ts",
    [
      `export function render(id: string): void {`,
      `  const handler = (value: string): void => {`,
      `    void value;`,
      `  };`,
      `  handler(id);`,
      `}`,
      ``,
    ].join("\n"),
  );
}

const FUNCTION_SCOPED_CALLBACK_CALL: CallRef = {
  callText: "handler(id)",
  receiver: null,
  member: "handler",
  startLine: 5,
};

const PANEL_HANDLER_TABLE = (): InMemoryGlobalSymbolTable =>
  tableOf({ relPath: "src/panel.ts", symbol: sym("Panel#handler", "handler", "src/panel.ts", ["Panel"]) });

/** The same shape one scope deeper — a class METHOD body rather than a function body. */
function writeMethodScopedCallbackFixture(repoRoot: string): void {
  writeSource(
    repoRoot,
    "src/widget.ts",
    [
      `export class Widget {`,
      `  render(id: string): void {`,
      `    const handler = (value: string): void => {`,
      `      void value;`,
      `    };`,
      `    handler(id);`,
      `  }`,
      `}`,
      ``,
    ].join("\n"),
  );
}

const METHOD_SCOPED_CALLBACK_CALL: CallRef = {
  callText: "handler(id)",
  receiver: null,
  member: "handler",
  startLine: 6,
};

/**
 * THE RECALL GUARD, and the reason this fix is a scope test rather than a
 * declaration-kind test.
 *
 * A MODULE-LEVEL `const` arrow is a top-level declaration of the file — the kind
 * of thing a symbol table names and a bare call SHOULD resolve to. Widening
 * `isLocalValueBinding` to `ts.isVariableDeclaration` without asking WHERE the
 * declaration sits would swallow it, turning a precision fix into a recall
 * regression that no other test in this tree would catch.
 *
 * The symbol is injected rather than walked on purpose: `tsNameOf` does not name
 * a bare `const` arrow today (it names function/class/method declarations and
 * const-object namespaces), so the table is the only place the boundary can be
 * stated. The guard must decline on the DECLARATION's scope, never on the
 * table's contents.
 */
function writeModuleLevelArrowFixture(repoRoot: string): void {
  writeSource(
    repoRoot,
    "src/module-level.ts",
    [
      `const handler = (value: string): void => {`,
      `  void value;`,
      `};`,
      ``,
      `export function render(id: string): void {`,
      `  handler(id);`,
      `}`,
      ``,
    ].join("\n"),
  );
}

const MODULE_LEVEL_ARROW_CALL: CallRef = {
  callText: "handler(id)",
  receiver: null,
  member: "handler",
  startLine: 6,
};

const MODULE_LEVEL_TABLE = (): InMemoryGlobalSymbolTable =>
  tableOf({ relPath: "src/module-level.ts", symbol: sym("handler", "handler", "src/module-level.ts", []) });

/**
 * A function-scoped `const` holding a hook RETURN — the composition with bd
 * tea-rags-mcp-qdjfu. `useNavigate()` is declared in `node_modules`, so the value
 * behind `navigate` provably never reaches project code and the call belongs in
 * the external bucket rather than the internal-miss denominator.
 *
 * Note the binding is a plain `const`, not a destructuring pattern: before this
 * bead `classifyLocalCallee` answered `notLocalBinding` for it, so the external
 * arm qdjfu added could not see the call at all.
 */
function writeExternalHookReturnFixture(repoRoot: string): void {
  writePackage(repoRoot, "router", [`export declare function useNavigate(): (to: string) => void;`, ``]);
  writeSource(
    repoRoot,
    "src/nav.ts",
    [
      `import { useNavigate } from "router";`,
      ``,
      `export function Nav(to: string): void {`,
      `  const navigate = useNavigate();`,
      `  navigate(to);`,
      `}`,
      ``,
    ].join("\n"),
  );
}

const EXTERNAL_HOOK_RETURN_CALL: CallRef = {
  callText: "navigate(to)",
  receiver: null,
  member: "navigate",
  startLine: 5,
};

const NAVIGATE_TABLE = (): InMemoryGlobalSymbolTable =>
  tableOf({ relPath: "src/nav-helpers.ts", symbol: sym("navigate", "navigate", "src/nav-helpers.ts", []) });

/**
 * A function-scoped `const` holding a PROJECT instance, dispatched on. The
 * receiver twin (bd tea-rags-mcp-z0zqd) reads the same
 * {@link isLocalValueBinding}, so widening that predicate puts this edge at risk
 * — and it must not move: the second half of the receiver guard asks whether the
 * type names an in-project declaration, and `ProjectStore` does.
 */
function writeProjectInstanceReceiverFixture(repoRoot: string): void {
  writeSource(
    repoRoot,
    "src/store.ts",
    [`export class ProjectStore {`, `  save(value: string): void {`, `    void value;`, `  }`, `}`, ``].join("\n"),
  );
  writeSource(
    repoRoot,
    "src/consumer.ts",
    [
      `import { ProjectStore } from "./store.js";`,
      ``,
      `export function consume(value: string): void {`,
      `  const store = new ProjectStore();`,
      `  store.save(value);`,
      `}`,
      ``,
    ].join("\n"),
  );
}

const PROJECT_INSTANCE_CALL: CallRef = {
  callText: "store.save(value)",
  receiver: "store",
  member: "save",
  startLine: 5,
};

const SAVE_TABLE = (): InMemoryGlobalSymbolTable =>
  tableOf({ relPath: "src/store.ts", symbol: sym("ProjectStore#save", "save", "src/store.ts", ["ProjectStore"]) });

/**
 * bd tea-rags-mcp-w7qv4 — a bare call whose callee is a FUNCTION-SCOPED variable.
 *
 * bd tea-rags-mcp-5tatv accepted two declaration kinds, `ts.isParameter` and
 * `ts.isBindingElement`, and a locally declared callback is neither. The fix is a
 * SCOPE test rather than one more kind: a `const` inside a function body cannot
 * be the project symbol a short name matched, while the identically-shaped
 * declaration at module level can be, and declining that one would suppress real
 * edges.
 */
describe("TSGlobalShortNameSymbolResolutionStrategy — function-scoped callee guard (bd tea-rags-mcp-w7qv4)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-local-callee-scope-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const strategy = (): TSGlobalShortNameSymbolResolutionStrategy =>
    new TSGlobalShortNameSymbolResolutionStrategy(cfg, new TSProgramCache({ repoRoot, tsOptions }));

  it("continues for a callback declared as a function-scoped const (render handler(id))", () => {
    writeFunctionScopedCallbackFixture(repoRoot);
    expect(strategy().attempt(FUNCTION_SCOPED_CALLBACK_CALL, ctx("src/renderer.ts", PANEL_HANDLER_TABLE())).kind).toBe(
      "continue",
    );
  });

  it("continues for the same const declared inside a class method body (Widget#render handler(id))", () => {
    writeMethodScopedCallbackFixture(repoRoot);
    expect(strategy().attempt(METHOD_SCOPED_CALLBACK_CALL, ctx("src/widget.ts", PANEL_HANDLER_TABLE())).kind).toBe(
      "continue",
    );
  });

  it("STILL resolves a bare call to a MODULE-LEVEL const arrow — the recall guard", () => {
    writeModuleLevelArrowFixture(repoRoot);
    expect(strategy().attempt(MODULE_LEVEL_ARROW_CALL, ctx("src/module-level.ts", MODULE_LEVEL_TABLE()))).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/module-level.ts", targetSymbolId: "handler" },
    });
  });

  it("behaves exactly as before when no Program cache is injected (the disabled state)", () => {
    writeFunctionScopedCallbackFixture(repoRoot);
    expect(
      new TSGlobalShortNameSymbolResolutionStrategy(cfg, null).attempt(
        FUNCTION_SCOPED_CALLBACK_CALL,
        ctx("src/renderer.ts", PANEL_HANDLER_TABLE()),
      ),
    ).toEqual({ kind: "resolved", target: { targetRelPath: "src/panel.ts", targetSymbolId: "Panel#handler" } });
  });
});

/**
 * bd tea-rags-mcp-w7qv4 — the same decision through the whole chain, plus the two
 * predicates that read {@link isLocalValueBinding} alongside the precision one.
 */
describe("TSCallResolver — function-scoped callee guard end to end (bd tea-rags-mcp-w7qv4)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-local-callee-scope-e2e-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const resolver = (): TSCallResolver => new TSCallResolver(tsOptions, DEFAULT_AMBIGUOUS_RESOLVE_MODE, repoRoot);

  it("emits no edge for a function-scoped const callback called bare (handler(id))", () => {
    writeFunctionScopedCallbackFixture(repoRoot);
    expect(resolver().resolve(FUNCTION_SCOPED_CALLBACK_CALL, ctx("src/renderer.ts", PANEL_HANDLER_TABLE()))).toBeNull();
  });

  it("keeps a project-declared local callback in the internal denominator — declining is not externality", () => {
    writeFunctionScopedCallbackFixture(repoRoot);
    expect(
      resolver().targetsExternalImport(FUNCTION_SCOPED_CALLBACK_CALL, ctx("src/renderer.ts", PANEL_HANDLER_TABLE())),
    ).toBe(false);
  });

  it("STILL emits the edge for a bare call to a module-level const arrow — the recall guard", () => {
    writeModuleLevelArrowFixture(repoRoot);
    expect(resolver().resolve(MODULE_LEVEL_ARROW_CALL, ctx("src/module-level.ts", MODULE_LEVEL_TABLE()))).toEqual({
      targetRelPath: "src/module-level.ts",
      targetSymbolId: "handler",
    });
  });

  it("classifies a function-scoped const holding a hook RETURN as external (Nav navigate(to))", () => {
    writeExternalHookReturnFixture(repoRoot);
    expect(resolver().targetsExternalImport(EXTERNAL_HOOK_RETURN_CALL, ctx("src/nav.ts", NAVIGATE_TABLE()))).toBe(true);
  });

  it("emits no edge for that reclassified hook return either — it was already declined", () => {
    writeExternalHookReturnFixture(repoRoot);
    expect(resolver().resolve(EXTERNAL_HOOK_RETURN_CALL, ctx("src/nav.ts", NAVIGATE_TABLE()))).toBeNull();
  });

  it("STILL resolves a dispatch on a function-scoped const holding a PROJECT instance (store.save)", () => {
    writeProjectInstanceReceiverFixture(repoRoot);
    expect(resolver().resolve(PROJECT_INSTANCE_CALL, ctx("src/consumer.ts", SAVE_TABLE()))).toEqual({
      targetRelPath: "src/store.ts",
      targetSymbolId: "ProjectStore#save",
    });
  });
});
