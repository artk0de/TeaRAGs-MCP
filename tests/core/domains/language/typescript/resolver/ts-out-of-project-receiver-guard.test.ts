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

/**
 * A dependency installed the way every real project installs one — UNDER the
 * repo root, in `node_modules`. That placement is the whole point of these
 * fixtures: it is what a repo-root-relative path test cannot tell apart from
 * the project's own sources.
 */
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
 * One project symbol per colliding short name, so `globalShortName` is confident
 * enough to fabricate under strict mode. Every declined call below would
 * otherwise land on one of these.
 */
const collidingTable = (): InMemoryGlobalSymbolTable => {
  const table = new InMemoryGlobalSymbolTable();
  table.upsertFile("src/memo.ts", [sym("CommitDiffMemo#set", "set", "src/memo.ts", ["CommitDiffMemo"])]);
  table.upsertFile("src/cursor.ts", [sym("ChunkCursor#next", "next", "src/cursor.ts", ["ChunkCursor"])]);
  table.upsertFile("src/render.ts", [sym("Renderer#text", "text", "src/render.ts", ["Renderer"])]);
  table.upsertFile("src/tree.ts", [sym("TreeIndex#child", "child", "src/tree.ts", ["TreeIndex"])]);
  table.upsertFile("src/bus.ts", [sym("Bus#emit", "emit", "src/bus.ts", ["Bus"])]);
  table.upsertFile("src/store.ts", [sym("Store#put", "put", "src/store.ts", ["Store"])]);
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
 * `app.set` — an express `Application`. The receiver's type IS resolvable, and
 * it is neither a project class nor an ECMAScript builtin: it is declared in a
 * package under the repo root.
 */
function writeExpressFixture(repoRoot: string): void {
  writePackage(
    repoRoot,
    "express",
    [
      `export interface Application {`,
      `  set(name: string, value: unknown): void;`,
      `}`,
      `declare function express(): Application;`,
      `export default express;`,
      ``,
    ].join("\n"),
  );
  writeSource(
    repoRoot,
    "src/server.ts",
    [
      `import express from "express";`,
      ``,
      `export function boot(): void {`,
      `  const app = express();`,
      `  app.set("trust proxy", 1);`,
      `}`,
      ``,
    ].join("\n"),
  );
}

const EXPRESS_APP_SET: CallRef = {
  callText: 'app.set("trust proxy", 1)',
  receiver: "app",
  member: "set",
  startLine: 5,
};

/**
 * `node.child` — a tree-sitter node handed back by another package call. Same
 * shape as express, different package, and the member (`child`) is one a real
 * project symbol also carries.
 */
function writeTreeSitterFixture(repoRoot: string): void {
  writePackage(
    repoRoot,
    "tree-sitter",
    [
      `export interface SyntaxNode {`,
      `  child(index: number): SyntaxNode;`,
      `}`,
      `export declare function parse(source: string): SyntaxNode;`,
      ``,
    ].join("\n"),
  );
  writeSource(
    repoRoot,
    "src/walker.ts",
    [
      `import { parse } from "tree-sitter";`,
      ``,
      `export function firstChild(source: string): void {`,
      `  const node = parse(source);`,
      `  node.child(0);`,
      `}`,
      ``,
    ].join("\n"),
  );
}

const TREE_SITTER_NODE_CHILD: CallRef = {
  callText: "node.child(0)",
  receiver: "node",
  member: "child",
  startLine: 5,
};

/**
 * `receiverFiles.values().next()` — a `MapIterator`. A real default-lib type
 * that {@link ECMASCRIPT_BUILTIN_TYPES} does not enumerate, which is why
 * widening that set was never the lever.
 */
function writeMapIteratorFixture(repoRoot: string): void {
  writeSource(
    repoRoot,
    "src/registry.ts",
    [
      `export function firstKey(receiverFiles: Map<string, number>): void {`,
      `  receiverFiles.values().next();`,
      `}`,
      ``,
    ].join("\n"),
  );
}

const MAP_ITERATOR_NEXT: CallRef = {
  callText: "receiverFiles.values().next()",
  receiver: "receiverFiles.values()",
  member: "next",
  startLine: 2,
};

/** `response.text()` — a default-lib DOM type, absent from the builtin set. */
function writeResponseFixture(repoRoot: string): void {
  writeSource(
    repoRoot,
    "src/http.ts",
    [
      `export async function fetchText(url: string): Promise<string> {`,
      `  const response = await fetch(url);`,
      `  return response.text();`,
      `}`,
      ``,
    ].join("\n"),
  );
}

const RESPONSE_TEXT: CallRef = {
  callText: "response.text()",
  receiver: "response",
  member: "text",
  startLine: 3,
};

/**
 * RECALL GUARD — a project class that EXTENDS a package base class. The member
 * is declared in `node_modules`, but the receiver's TYPE is the project class,
 * so the call reaches project code and the edge must survive.
 */
function writeExtendsPackageBaseFixture(repoRoot: string): void {
  writePackage(
    repoRoot,
    "emitter-pkg",
    [`export declare class BaseEmitter {`, `  emit(name: string): void;`, `}`, ``].join("\n"),
  );
  writeSource(
    repoRoot,
    "src/bus.ts",
    [
      `import { BaseEmitter } from "emitter-pkg";`,
      ``,
      `export class Bus extends BaseEmitter {}`,
      ``,
      `export function makeBus(): Bus {`,
      `  return new Bus();`,
      `}`,
      ``,
    ].join("\n"),
  );
  writeSource(
    repoRoot,
    "src/bus-caller.ts",
    [
      `import { makeBus } from "./bus.js";`,
      ``,
      `export function run(): void {`,
      `  const bus = makeBus();`,
      `  bus.emit("ready");`,
      `}`,
      ``,
    ].join("\n"),
  );
}

const PROJECT_SUBCLASS_EMIT: CallRef = {
  callText: 'bus.emit("ready")',
  receiver: "bus",
  member: "emit",
  startLine: 5,
};

/**
 * RECALL GUARD — a project type reached through a BARREL re-export. The bead
 * named this as the shape most likely to be misread as external.
 */
function writeBarrelReExportFixture(repoRoot: string): void {
  writeSource(
    repoRoot,
    "src/inner/store.ts",
    [`export class Store {`, `  put(key: string): void {`, `    void key;`, `  }`, `}`, ``].join("\n"),
  );
  writeSource(
    repoRoot,
    "src/inner/index.ts",
    [
      `export { Store } from "./store.js";`,
      `import { Store } from "./store.js";`,
      ``,
      `export function makeStore(): Store {`,
      `  return new Store();`,
      `}`,
      ``,
    ].join("\n"),
  );
  writeSource(
    repoRoot,
    "src/store-caller.ts",
    [
      `import { makeStore } from "./inner/index.js";`,
      ``,
      `export function run(): void {`,
      `  const store = makeStore();`,
      `  store.put("k");`,
      `}`,
      ``,
    ].join("\n"),
  );
}

const BARREL_STORE_PUT: CallRef = {
  callText: 'store.put("k")',
  receiver: "store",
  member: "put",
  startLine: 5,
};

/**
 * bd tea-rags-mcp-otm6n — the residual bd tea-rags-mcp-335eu left behind.
 *
 * 335eu's arm asks whether the receiver's type is a NAME in a closed builtin
 * vocabulary. `MapIterator` and `Response` are real default-lib types that set
 * never enumerated, and a package type is not a builtin at all — so the set
 * would have to grow with every dependency to reach them.
 *
 * The question the guard asks instead is the one `targetsExternalImport` is
 * named after: does this call LEAVE THE PROJECT. The evidence is where the
 * receiver's type is DECLARED — and "the project" has to mean the project's own
 * sources, not merely the repo directory, because `node_modules` lives inside
 * the repo root too.
 */
describe("TSGlobalShortNameSymbolResolutionStrategy — out-of-project receiver guard (bd tea-rags-mcp-otm6n)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-out-of-project-guard-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const strategy = (): TSGlobalShortNameSymbolResolutionStrategy =>
    new TSGlobalShortNameSymbolResolutionStrategy(cfg, new TSProgramCache({ repoRoot, tsOptions }));

  it("continues for an express Application under the repo root (server.ts app.set)", () => {
    writeExpressFixture(repoRoot);
    expect(strategy().attempt(EXPRESS_APP_SET, ctx("src/server.ts")).kind).toBe("continue");
  });

  it("continues for a tree-sitter SyntaxNode returned by a package call (walker.ts node.child)", () => {
    writeTreeSitterFixture(repoRoot);
    expect(strategy().attempt(TREE_SITTER_NODE_CHILD, ctx("src/walker.ts")).kind).toBe("continue");
  });

  it("continues for a MapIterator the builtin vocabulary never enumerated (registry.ts values().next())", () => {
    writeMapIteratorFixture(repoRoot);
    expect(strategy().attempt(MAP_ITERATOR_NEXT, ctx("src/registry.ts")).kind).toBe("continue");
  });

  it("continues for a default-lib Response (http.ts response.text())", () => {
    writeResponseFixture(repoRoot);
    expect(strategy().attempt(RESPONSE_TEXT, ctx("src/http.ts")).kind).toBe("continue");
  });

  it("STILL resolves for a project class extending a package base class (bus.emit)", () => {
    writeExtendsPackageBaseFixture(repoRoot);
    expect(
      strategy().attempt(
        PROJECT_SUBCLASS_EMIT,
        ctx("src/bus-caller.ts", { imports: [{ importText: "./bus.js", startLine: 1, importedNames: ["makeBus"] }] }),
      ),
    ).toEqual({ kind: "resolved", target: { targetRelPath: "src/bus.ts", targetSymbolId: "Bus#emit" } });
  });

  it("STILL resolves for a project type re-exported through a barrel (store.put)", () => {
    writeBarrelReExportFixture(repoRoot);
    expect(
      strategy().attempt(
        BARREL_STORE_PUT,
        ctx("src/store-caller.ts", {
          imports: [{ importText: "./inner/index.js", startLine: 1, importedNames: ["makeStore"] }],
        }),
      ),
    ).toEqual({ kind: "resolved", target: { targetRelPath: "src/store.ts", targetSymbolId: "Store#put" } });
  });

  it("STILL resolves when the receiver is untyped `any` — no symbol is no evidence", () => {
    writeSource(
      repoRoot,
      "src/untyped.ts",
      [`export function run(input: any): void {`, `  const store = input.pick();`, `  store.put("k");`, `}`, ``].join(
        "\n",
      ),
    );
    expect(strategy().attempt(BARREL_STORE_PUT, ctx("src/untyped.ts"))).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/store.ts", targetSymbolId: "Store#put" },
    });
  });

  it("behaves exactly as before when no Program cache is injected (the disabled state)", () => {
    writeExpressFixture(repoRoot);
    expect(
      new TSGlobalShortNameSymbolResolutionStrategy(cfg, null).attempt(EXPRESS_APP_SET, ctx("src/server.ts")),
    ).toEqual({ kind: "resolved", target: { targetRelPath: "src/memo.ts", targetSymbolId: "CommitDiffMemo#set" } });
  });
});

/**
 * bd tea-rags-mcp-otm6n — the same verdict through the whole chain, plus the
 * classifier half. A call declined BECAUSE its receiver is an express
 * `Application` must also leave the internal `resolveSuccessRate` denominator,
 * or the resolver is penalised for being right.
 */
describe("TSCallResolver — out-of-project receiver guard end to end (bd tea-rags-mcp-otm6n)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-out-of-project-e2e-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("emits no edge for app.set on an express Application", () => {
    writeExpressFixture(repoRoot);
    const resolver = new TSCallResolver(tsOptions, DEFAULT_AMBIGUOUS_RESOLVE_MODE, repoRoot);
    expect(resolver.resolve(EXPRESS_APP_SET, ctx("src/server.ts"))).toBeNull();
  });

  it("counts that same call as external so it leaves the resolveSuccessRate denominator", () => {
    writeExpressFixture(repoRoot);
    const resolver = new TSCallResolver(tsOptions, DEFAULT_AMBIGUOUS_RESOLVE_MODE, repoRoot);
    expect(resolver.targetsExternalImport(EXPRESS_APP_SET, ctx("src/server.ts"))).toBe(true);
  });

  it("STILL emits the real edge for the project subclass (bus.emit)", () => {
    writeExtendsPackageBaseFixture(repoRoot);
    const resolver = new TSCallResolver(tsOptions, DEFAULT_AMBIGUOUS_RESOLVE_MODE, repoRoot);
    expect(
      resolver.resolve(
        PROJECT_SUBCLASS_EMIT,
        ctx("src/bus-caller.ts", { imports: [{ importText: "./bus.js", startLine: 1, importedNames: ["makeBus"] }] }),
      ),
    ).toEqual({ targetRelPath: "src/bus.ts", targetSymbolId: "Bus#emit" });
  });

  it("CODEGRAPH_TS_TYPECHECKER=0 keeps the guard exactly as it was — no checker involvement", () => {
    writeExpressFixture(repoRoot);
    const previous = process.env.CODEGRAPH_TS_TYPECHECKER;
    process.env.CODEGRAPH_TS_TYPECHECKER = "0";
    try {
      const resolver = new TSCallResolver(tsOptions, DEFAULT_AMBIGUOUS_RESOLVE_MODE, repoRoot);
      expect(resolver.programCache).toBeNull();
      expect(resolver.resolve(EXPRESS_APP_SET, ctx("src/server.ts"))).toEqual({
        targetRelPath: "src/memo.ts",
        targetSymbolId: "CommitDiffMemo#set",
      });
      expect(resolver.targetsExternalImport(EXPRESS_APP_SET, ctx("src/server.ts"))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.CODEGRAPH_TS_TYPECHECKER;
      else process.env.CODEGRAPH_TS_TYPECHECKER = previous;
    }
  });
});
