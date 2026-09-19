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
import { targetsExternalImport } from "../../../../../../src/core/domains/language/typescript/resolver/ts-external-call.js";
import { interfaceReceiverExcludesCandidate } from "../../../../../../src/core/domains/language/typescript/resolver/ts-interface-receiver.js";
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

/** A dependency installed where every real project installs one — under the repo root. */
function writePackage(repoRoot: string, name: string, declaration: string): void {
  writeSource(
    repoRoot,
    `node_modules/${name}/package.json`,
    JSON.stringify({ name, version: "1.0.0", types: "index.d.ts" }),
  );
  writeSource(repoRoot, `node_modules/${name}/index.d.ts`, declaration);
}

const sym = (symbolId: string, shortName: string, relPath: string, scope: string[]): NamedSymbol => ({
  symbolId,
  fqName: symbolId,
  shortName,
  relPath,
  scope,
});

/**
 * The project look-alikes. Each is a real in-project symbol whose SHORT NAME
 * collides with a member of an out-of-project type the project also calls
 * against — the shape `src/core/infra/materialize.ts` has by design, since
 * `MaterializedNode` mirrors tree-sitter's `SyntaxNode` interface deliberately.
 * One symbol per name, so `globalShortName` is confident enough to commit.
 */
const collidingTable = (): InMemoryGlobalSymbolTable => {
  const table = new InMemoryGlobalSymbolTable();
  table.upsertFile("src/tree.ts", [sym("TreeIndex#child", "child", "src/tree.ts", ["TreeIndex"])]);
  table.upsertFile("src/render.ts", [sym("Renderer#text", "text", "src/render.ts", ["Renderer"])]);
  table.upsertFile("src/timer.ts", [sym("OverallTimer#stop", "stop", "src/timer.ts", ["OverallTimer"])]);
  table.upsertFile("src/store.ts", [
    sym("Store", "Store", "src/store.ts", []),
    sym("Store#put", "put", "src/store.ts", ["Store"]),
  ]);
  return table;
};

const ctx = (callerFile: string, over: Partial<CallContext> = {}): CallContext => ({
  callerFile,
  callerScope: [],
  imports: [],
  symbolTable: collidingTable(),
  ...over,
});

/**
 * The materialize.ts / gemfile.ts shape: a parameter ANNOTATED with a package
 * type. The walker records the annotation verbatim (`Parser.SyntaxNode`), which
 * is precisely what stopped the guard from asking the checker.
 */
function writeAnnotatedTreeSitterFixture(repoRoot: string): void {
  writePackage(
    repoRoot,
    "tree-sitter",
    [
      `export declare namespace Parser {`,
      `  interface SyntaxNode {`,
      `    child(index: number): SyntaxNode;`,
      `  }`,
      `}`,
      ``,
    ].join("\n"),
  );
  writeSource(
    repoRoot,
    "src/walker.ts",
    [
      `import type { Parser } from "tree-sitter";`,
      ``,
      `export function firstChild(native: Parser.SyntaxNode): void {`,
      `  native.child(0);`,
      `}`,
      ``,
    ].join("\n"),
  );
}

const ANNOTATED_NODE_CHILD: CallRef = {
  callText: "native.child(0)",
  receiver: "native",
  member: "child",
  startLine: 4,
};

const annotatedNodeCtx = (): CallContext =>
  ctx("src/walker.ts", {
    imports: [{ importText: "tree-sitter", startLine: 1, importedNames: ["Parser"] }],
    localBindings: { native: [{ line: 3, type: "Parser.SyntaxNode" }] },
  });

/**
 * The ollama.ts shape: a local ANNOTATED with a default-lib type the builtin
 * vocabulary never enumerated. `Response` is not in `ECMASCRIPT_BUILTIN_TYPES`,
 * and growing that set per dependency was rejected as the lever in
 * bd tea-rags-mcp-otm6n.
 */
function writeAnnotatedResponseFixture(repoRoot: string): void {
  writeSource(
    repoRoot,
    "src/http.ts",
    [
      `export async function fetchText(url: string): Promise<string> {`,
      `  const response: Response = await fetch(url);`,
      `  return response.text();`,
      `}`,
      ``,
    ].join("\n"),
  );
}

const ANNOTATED_RESPONSE_TEXT: CallRef = {
  callText: "response.text()",
  receiver: "response",
  member: "text",
  startLine: 3,
};

const annotatedResponseCtx = (): CallContext =>
  ctx("src/http.ts", { localBindings: { response: [{ line: 2, type: "Response" }] } });

/**
 * The renderer.ts shape: a `this.<field>` receiver whose FIELD carries the
 * annotation. Same defect through `classFieldTypes` rather than
 * `localBindings`, so both arms of `receiverTypeName` are pinned.
 */
function writeAnnotatedFieldFixture(repoRoot: string): void {
  writePackage(repoRoot, "cli-progress", [`export declare class MultiBar {`, `  stop(): void;`, `}`, ``].join("\n"));
  writeSource(
    repoRoot,
    "src/progress.ts",
    [
      `import { MultiBar } from "cli-progress";`,
      ``,
      `export class ProgressRenderer {`,
      `  private readonly multibar: MultiBar = new MultiBar();`,
      ``,
      `  finish(): void {`,
      `    this.multibar.stop();`,
      `  }`,
      `}`,
      ``,
    ].join("\n"),
  );
}

const ANNOTATED_FIELD_STOP: CallRef = {
  callText: "this.multibar.stop()",
  receiver: "this.multibar",
  member: "stop",
  startLine: 7,
};

const annotatedFieldCtx = (): CallContext =>
  ctx("src/progress.ts", {
    callerScope: ["ProgressRenderer"],
    imports: [{ importText: "cli-progress", startLine: 1, importedNames: ["MultiBar"] }],
    classFieldTypes: { ProgressRenderer: { multibar: "MultiBar" } },
  });

/**
 * RECALL GUARD — a receiver annotated with a PROJECT class. The annotation is
 * the author's own type, the symbol table declares it, and the edge must
 * survive untouched: this is the recall surface the guard's docblock warned
 * widening would put in reach.
 */
function writeAnnotatedProjectTypeFixture(repoRoot: string): void {
  writeSource(
    repoRoot,
    "src/store.ts",
    [`export class Store {`, `  put(key: string): void {`, `    void key;`, `  }`, `}`, ``].join("\n"),
  );
  writeSource(
    repoRoot,
    "src/store-caller.ts",
    [
      `import { Store } from "./store.js";`,
      ``,
      `export function run(store: Store): void {`,
      `  store.put("k");`,
      `}`,
      ``,
    ].join("\n"),
  );
}

const ANNOTATED_PROJECT_PUT: CallRef = {
  callText: 'store.put("k")',
  receiver: "store",
  member: "put",
  startLine: 4,
};

const annotatedProjectCtx = (): CallContext =>
  ctx("src/store-caller.ts", {
    imports: [{ importText: "./store.js", startLine: 1, importedNames: ["Store"] }],
    localBindings: { store: [{ line: 3, type: "Store" }] },
  });

/**
 * bd tea-rags-mcp-3somv — the residual bd tea-rags-mcp-otm6n left behind.
 *
 * otm6n's checker arm is reached only by receivers NOTHING could type. A
 * receiver the walker DID annotate short-circuits one branch earlier, where the
 * guard decides by NAME: "not an ECMAScript builtin" reads as "an ordinary
 * project type". So `native: Parser.SyntaxNode` and `response: Response` were
 * answered "internal", `globalShortName` matched the bare member against the
 * whole symbol table, and the project's deliberate look-alikes
 * (`MaterializedNode#child`, `MaterializedNode#text`) collected the edge.
 *
 * The name still decides whenever the PROJECT declares something by it. Only
 * when it declares nothing does the checker get asked where the type actually
 * lives — which is the question `targetsExternalImport` is named after.
 */
describe("TSGlobalShortNameSymbolResolutionStrategy — annotated out-of-project receiver (bd tea-rags-mcp-3somv)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-annotated-external-guard-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const strategy = (): TSGlobalShortNameSymbolResolutionStrategy =>
    new TSGlobalShortNameSymbolResolutionStrategy(cfg, new TSProgramCache({ repoRoot, tsOptions }));

  it("continues for a parameter annotated with a package type (walker.ts native.child)", () => {
    writeAnnotatedTreeSitterFixture(repoRoot);
    expect(strategy().attempt(ANNOTATED_NODE_CHILD, annotatedNodeCtx()).kind).toBe("continue");
  });

  it("continues for a local annotated with a default-lib type (http.ts response.text)", () => {
    writeAnnotatedResponseFixture(repoRoot);
    expect(strategy().attempt(ANNOTATED_RESPONSE_TEXT, annotatedResponseCtx()).kind).toBe("continue");
  });

  it("continues for a this.<field> whose field is annotated with a package type (progress.ts multibar.stop)", () => {
    writeAnnotatedFieldFixture(repoRoot);
    // The guard's own verdict first: the member-evidence guard declines the
    // same call, so the `continue` alone does not show this guard spoke (bd
    // tea-rags-mcp-t5cji).
    const cache = new TSProgramCache({ repoRoot, tsOptions });
    expect(targetsExternalImport(ANNOTATED_FIELD_STOP, annotatedFieldCtx(), tsOptions, cache)).toBe(true);
    expect(strategy().attempt(ANNOTATED_FIELD_STOP, annotatedFieldCtx()).kind).toBe("continue");
  });

  /**
   * The recall guard: an annotation naming a project class must keep its edge.
   * Asserted on the CHAIN rather than on this pass, because which pass answers
   * is not the invariant: `localBinding` at position 4 owns a walker-typed
   * receiver whose member the table carries, and since bd tea-rags-mcp-dubkx
   * position 9 declines that population outright.
   */
  it("STILL emits the edge when the annotation names a project class the symbol table declares (store.put)", () => {
    writeAnnotatedProjectTypeFixture(repoRoot);
    const resolver = new TSCallResolver(tsOptions, DEFAULT_AMBIGUOUS_RESOLVE_MODE, repoRoot);
    expect(resolver.resolve(ANNOTATED_PROJECT_PUT, annotatedProjectCtx())).toEqual({
      targetRelPath: "src/store.ts",
      targetSymbolId: "Store#put",
    });
  });

  /**
   * An annotation naming a PROJECT interface the symbol table carries no symbol
   * for is still an internal receiver — the 3somv half, asserted on the external
   * classifier. What it no longer does is hand the member to the project's only
   * `put`: `Store` is unrelated to `Putter`, so that edge was decided by the
   * short name being unique, which is the defect bd tea-rags-mcp-hwwtw removed.
   */
  it("keeps an annotation naming a project interface internal without matching its member by short-name uniqueness", () => {
    writeSource(
      repoRoot,
      "src/shapes.ts",
      [`export interface Putter {`, `  put(key: string): void;`, `}`, ``].join("\n"),
    );
    writeSource(
      repoRoot,
      "src/putter-caller.ts",
      [
        `import type { Putter } from "./shapes.js";`,
        ``,
        `export function run(store: Putter): void {`,
        `  store.put("k");`,
        `}`,
        ``,
      ].join("\n"),
    );
    const call: CallRef = { ...ANNOTATED_PROJECT_PUT, startLine: 4 };
    const putterCtx = (): CallContext =>
      ctx("src/putter-caller.ts", {
        imports: [{ importText: "./shapes.js", startLine: 1, importedNames: ["Putter"] }],
        localBindings: { store: [{ line: 3, type: "Putter" }] },
      });
    const resolver = new TSCallResolver(tsOptions, DEFAULT_AMBIGUOUS_RESOLVE_MODE, repoRoot);
    expect(resolver.targetsExternalImport(call, putterCtx())).toBe(false);
    // The hwwtw guard's own verdict: `Store#put` is not `Putter`'s and no
    // `implements` connects them. Asserted directly because the member-evidence
    // guard declines the same candidate (bd tea-rags-mcp-t5cji).
    const storePut = sym("Store#put", "put", "src/store.ts", ["Store"]);
    const cache = new TSProgramCache({ repoRoot, tsOptions });
    expect(interfaceReceiverExcludesCandidate(call, putterCtx(), cache, storePut)).toBe(true);
    expect(strategy().attempt(call, putterCtx()).kind).toBe("continue");
  });

  /**
   * THE TRADE, stated rather than left to chance. When the annotation names a
   * package base class the project also SUBCLASSES, this guard declines: the
   * author wrote the package type, the member is declared in the package, and
   * matching a bare member name against the whole symbol table is not what
   * makes the subclass the target. Fan-out to implementers is
   * `ConeDispatchResolver`'s contract, not `resolve`'s — the single-target
   * chain has no principled way to pick one.
   */
  it("declines a receiver annotated with a package base class even where a project subclass exists", () => {
    writePackage(
      repoRoot,
      "emitter-pkg",
      [`export declare class BaseEmitter {`, `  put(key: string): void;`, `}`, ``].join("\n"),
    );
    writeSource(
      repoRoot,
      "src/bus.ts",
      [`import { BaseEmitter } from "emitter-pkg";`, ``, `export class Bus extends BaseEmitter {}`, ``].join("\n"),
    );
    writeSource(
      repoRoot,
      "src/bus-caller.ts",
      [
        `import { BaseEmitter } from "emitter-pkg";`,
        ``,
        `export function run(bus: BaseEmitter): void {`,
        `  bus.put("k");`,
        `}`,
        ``,
      ].join("\n"),
    );
    expect(
      strategy().attempt(
        { callText: 'bus.put("k")', receiver: "bus", member: "put", startLine: 4 },
        ctx("src/bus-caller.ts", {
          imports: [{ importText: "emitter-pkg", startLine: 1, importedNames: ["BaseEmitter"] }],
          localBindings: { bus: [{ line: 3, type: "BaseEmitter" }] },
        }),
      ).kind,
    ).toBe("continue");
  });

  it("still declines a package-bound annotation with no Program cache — the import list needs no checker", () => {
    writeAnnotatedTreeSitterFixture(repoRoot);
    expect(targetsExternalImport(ANNOTATED_NODE_CHILD, annotatedNodeCtx(), tsOptions, null)).toBe(true);
    expect(
      new TSGlobalShortNameSymbolResolutionStrategy(cfg, null).attempt(ANNOTATED_NODE_CHILD, annotatedNodeCtx()).kind,
    ).toBe("continue");
  });

  it("does not call an UNBOUND annotation external with no Program cache — only the checker could have placed it", () => {
    writeAnnotatedResponseFixture(repoRoot);
    expect(targetsExternalImport(ANNOTATED_RESPONSE_TEXT, annotatedResponseCtx(), tsOptions, null)).toBe(false);
    // With no checker there is no evidence for the unique `text` either, and
    // `Response` is no type the project declares: the name pass declines (bd
    // tea-rags-mcp-t5cji).
    expect(
      new TSGlobalShortNameSymbolResolutionStrategy(cfg, null).attempt(ANNOTATED_RESPONSE_TEXT, annotatedResponseCtx())
        .kind,
    ).toBe("continue");
  });
});

/**
 * bd tea-rags-mcp-3somv — the same verdict through the whole chain, plus the
 * classifier half. A call declined BECAUSE its annotated receiver is a
 * tree-sitter `SyntaxNode` must also leave the internal `resolveSuccessRate`
 * denominator, or the resolver is penalised for being right.
 */
describe("TSCallResolver — annotated out-of-project receiver end to end (bd tea-rags-mcp-3somv)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-annotated-external-e2e-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("emits no edge for native.child on an annotated tree-sitter SyntaxNode", () => {
    writeAnnotatedTreeSitterFixture(repoRoot);
    const resolver = new TSCallResolver(tsOptions, DEFAULT_AMBIGUOUS_RESOLVE_MODE, repoRoot);
    expect(resolver.resolve(ANNOTATED_NODE_CHILD, annotatedNodeCtx())).toBeNull();
  });

  it("counts that same call as external so it leaves the resolveSuccessRate denominator", () => {
    writeAnnotatedTreeSitterFixture(repoRoot);
    const resolver = new TSCallResolver(tsOptions, DEFAULT_AMBIGUOUS_RESOLVE_MODE, repoRoot);
    expect(resolver.targetsExternalImport(ANNOTATED_NODE_CHILD, annotatedNodeCtx())).toBe(true);
  });

  it("STILL emits the real edge for a project-annotated receiver (store.put)", () => {
    writeAnnotatedProjectTypeFixture(repoRoot);
    const resolver = new TSCallResolver(tsOptions, DEFAULT_AMBIGUOUS_RESOLVE_MODE, repoRoot);
    expect(resolver.resolve(ANNOTATED_PROJECT_PUT, annotatedProjectCtx())).toEqual({
      targetRelPath: "src/store.ts",
      targetSymbolId: "Store#put",
    });
  });

  it("CODEGRAPH_TS_TYPECHECKER=0 keeps the pure arm and drops only the checker one", () => {
    writeAnnotatedTreeSitterFixture(repoRoot);
    writeAnnotatedResponseFixture(repoRoot);
    const previous = process.env.CODEGRAPH_TS_TYPECHECKER;
    process.env.CODEGRAPH_TS_TYPECHECKER = "0";
    try {
      const resolver = new TSCallResolver(tsOptions, DEFAULT_AMBIGUOUS_RESOLVE_MODE, repoRoot);
      expect(resolver.programCache).toBeNull();
      // Package-bound annotation: the import list alone answers, checker or not.
      expect(resolver.resolve(ANNOTATED_NODE_CHILD, annotatedNodeCtx())).toBeNull();
      expect(resolver.targetsExternalImport(ANNOTATED_NODE_CHILD, annotatedNodeCtx())).toBe(true);
      // Unbound annotation: nothing but the checker could place it, so the
      // disabled state does not call it external — and, with no checker to
      // vouch for the unique `text`, emits no edge either (bd tea-rags-mcp-t5cji).
      expect(resolver.resolve(ANNOTATED_RESPONSE_TEXT, annotatedResponseCtx())).toBeNull();
      expect(resolver.targetsExternalImport(ANNOTATED_RESPONSE_TEXT, annotatedResponseCtx())).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.CODEGRAPH_TS_TYPECHECKER;
      else process.env.CODEGRAPH_TS_TYPECHECKER = previous;
    }
  });
});
