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
  TSImportBasenameSymbolResolutionStrategy,
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

const sym = (symbolId: string, shortName: string, relPath: string, scope: string[]): NamedSymbol => ({
  symbolId,
  fqName: symbolId,
  shortName,
  relPath,
  scope,
});

/**
 * `get` / `set` each name exactly one project method, somewhere OTHER than the
 * file the basename match points at. That is the shape 4kx9f's vocabulary
 * exclusion was protecting: the words are real project members, so no
 * member-name set may decide on them.
 */
const collidingTable = (): InMemoryGlobalSymbolTable => {
  const table = new InMemoryGlobalSymbolTable();
  table.upsertFile("src/memo.ts", [
    sym("CommitDiffMemo#get", "get", "src/memo.ts", ["CommitDiffMemo"]),
    sym("CommitDiffMemo#set", "set", "src/memo.ts", ["CommitDiffMemo"]),
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
 * `trajectory/git/provider.ts:478` verbatim in shape. The receiver is a LOCAL
 * const holding a `Map` returned by a call, and its TEXT happens to be the
 * basename of a module the caller imports — so pass 6 matches the specifier,
 * finds no `get` inside `infra/cache.ts`, and parks a file-only edge onto a file
 * the call never enters.
 */
function writeCallResultMapFixture(repoRoot: string): void {
  writeSource(
    repoRoot,
    "src/git/infra/cache.ts",
    [
      `export interface BlameCacheEntry {`,
      `  oid: string;`,
      `}`,
      ``,
      `export class GitEnrichmentCache {`,
      `  load(): Map<string, BlameCacheEntry> {`,
      `    return new Map<string, BlameCacheEntry>();`,
      `  }`,
      `}`,
      ``,
    ].join("\n"),
  );
  writeSource(
    repoRoot,
    "src/git/provider.ts",
    [
      `import { GitEnrichmentCache } from "./infra/cache.js";`,
      ``,
      `export class GitEnrichmentProvider {`,
      `  private readonly store = new GitEnrichmentCache();`,
      ``,
      `  hydrate(relPath: string, oid: string): void {`,
      `    const cache = this.store.load();`,
      `    const cached = cache.get(relPath);`,
      `    if (cached === undefined) cache.set(relPath, { oid });`,
      `  }`,
      `}`,
      ``,
    ].join("\n"),
  );
}

const CACHE_GET: CallRef = { callText: "cache.get(relPath)", receiver: "cache", member: "get", startLine: 8 };
const CACHE_SET: CallRef = {
  callText: "cache.set(relPath, { oid })",
  receiver: "cache",
  member: "set",
  startLine: 9,
};

const mapCtx = (): CallContext =>
  ctx("src/git/provider.ts", {
    imports: [{ importText: "./infra/cache.js", startLine: 1, importedNames: ["GitEnrichmentCache"] }],
  });

/**
 * The recall guard, and the reason 4kx9f left `get` / `set` out of
 * {@link ECMASCRIPT_CONTAINER_PROTOTYPE_METHODS}: an imported project CONSTANT
 * whose type is a project class declaring both words. Same untyped-by-the-walker
 * shape, same basename collision, opposite correct answer.
 */
function writeProjectTypedConstantFixture(repoRoot: string): void {
  writeSource(
    repoRoot,
    "src/store.ts",
    [
      `export class ProjectStore {`,
      `  get(key: string): number {`,
      `    return key.length;`,
      `  }`,
      ``,
      `  set(key: string, value: number): void {`,
      `    void key;`,
      `    void value;`,
      `  }`,
      `}`,
      ``,
    ].join("\n"),
  );
  writeSource(
    repoRoot,
    "src/registry.ts",
    [`import { ProjectStore } from "./store.js";`, ``, `export const registry = new ProjectStore();`, ``].join("\n"),
  );
  writeSource(
    repoRoot,
    "src/consumer.ts",
    [
      `import { registry } from "./registry.js";`,
      ``,
      `export function read(key: string): number {`,
      `  return registry.get(key);`,
      `}`,
      ``,
      `export function write(key: string, value: number): void {`,
      `  registry.set(key, value);`,
      `}`,
      ``,
    ].join("\n"),
  );
}

const REGISTRY_GET: CallRef = { callText: "registry.get(key)", receiver: "registry", member: "get", startLine: 4 };
const REGISTRY_SET: CallRef = {
  callText: "registry.set(key, value)",
  receiver: "registry",
  member: "set",
  startLine: 8,
};

const constantCtx = (over: Partial<CallContext> = {}): CallContext =>
  ctx("src/consumer.ts", {
    imports: [{ importText: "./registry.js", startLine: 1, importedNames: ["registry"] }],
    ...over,
  });

/**
 * bd tea-rags-mcp-83iz5 — the residual bd tea-rags-mcp-4kx9f named and deferred.
 *
 * Pass 6 parks a file-only edge whenever an import specifier's BASENAME matches
 * the receiver text, and its guard was the only one in the chain still called
 * without the resolver's `TSProgramCache`. So the same predicate answered two
 * ways on one call: `TSCallResolver#targetsExternalImport` (checker-backed) put
 * `cache.get` outside the project, while the guard inside the pass — the same
 * function, one argument short — could not see the `Map` and parked the edge
 * anyway.
 *
 * The member-name route cannot close this. `get` / `set` are excluded from
 * {@link ECMASCRIPT_CONTAINER_PROTOTYPE_METHODS} precisely because project
 * classes carry those names, which is why these two survived 4kx9f. Deciding by
 * the receiver's TYPE instead keeps that protection intact by construction.
 */
describe("TSImportBasenameSymbolResolutionStrategy — checker-backed park guard (bd tea-rags-mcp-83iz5)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-import-basename-guard-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const strategy = (): TSImportBasenameSymbolResolutionStrategy =>
    new TSImportBasenameSymbolResolutionStrategy(cfg, new TSProgramCache({ repoRoot, tsOptions }));

  it("continues instead of parking a file-only edge for cache.get on a call-result Map", () => {
    writeCallResultMapFixture(repoRoot);
    expect(strategy().attempt(CACHE_GET, mapCtx()).kind).toBe("continue");
  });

  it("continues instead of parking a file-only edge for cache.set on a call-result Map", () => {
    writeCallResultMapFixture(repoRoot);
    expect(strategy().attempt(CACHE_SET, mapCtx()).kind).toBe("continue");
  });

  it("STILL parks the file-only edge for an imported CONSTANT the checker types as a project class (get)", () => {
    writeProjectTypedConstantFixture(repoRoot);
    expect(strategy().attempt(REGISTRY_GET, constantCtx())).toEqual({
      kind: "deferred",
      target: { targetRelPath: "src/registry.ts", targetSymbolId: null },
    });
  });

  it("STILL parks the file-only edge for that same project-typed constant on `set`", () => {
    writeProjectTypedConstantFixture(repoRoot);
    expect(strategy().attempt(REGISTRY_SET, constantCtx())).toEqual({
      kind: "deferred",
      target: { targetRelPath: "src/registry.ts", targetSymbolId: null },
    });
  });

  it("STILL pins the symbol when the matched file really declares the member — the guard sits after lookup", () => {
    writeProjectTypedConstantFixture(repoRoot);
    const table = collidingTable();
    table.upsertFile("src/registry.ts", [sym("Registry#get", "get", "src/registry.ts", ["Registry"])]);
    expect(strategy().attempt(REGISTRY_GET, constantCtx({ symbolTable: table }))).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/registry.ts", targetSymbolId: "Registry#get" },
    });
  });

  it("STILL parks when no Program can be built for the caller file (nothing on disk)", () => {
    expect(strategy().attempt(CACHE_GET, mapCtx())).toEqual({
      kind: "deferred",
      target: { targetRelPath: "src/git/infra/cache.ts", targetSymbolId: null },
    });
  });

  it("behaves exactly as before when no Program cache is injected (the disabled state)", () => {
    writeCallResultMapFixture(repoRoot);
    expect(new TSImportBasenameSymbolResolutionStrategy(cfg, null).attempt(CACHE_GET, mapCtx())).toEqual({
      kind: "deferred",
      target: { targetRelPath: "src/git/infra/cache.ts", targetSymbolId: null },
    });
  });
});

/**
 * bd tea-rags-mcp-83iz5 — the same decision through the whole chain. The
 * classifier half already answered "external" here, which is what made the
 * emitted edge a contradiction rather than a judgement call.
 */
describe("TSCallResolver — importBasename park guard end to end (bd tea-rags-mcp-83iz5)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-import-basename-guard-e2e-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("emits no edge for cache.get(relPath) onto the file whose basename the receiver shares", () => {
    writeCallResultMapFixture(repoRoot);
    const resolver = new TSCallResolver(tsOptions, DEFAULT_AMBIGUOUS_RESOLVE_MODE, repoRoot);
    expect(resolver.resolve(CACHE_GET, mapCtx())).toBeNull();
  });

  it("already counted that call external — the guard now agrees with the classifier", () => {
    writeCallResultMapFixture(repoRoot);
    const resolver = new TSCallResolver(tsOptions, DEFAULT_AMBIGUOUS_RESOLVE_MODE, repoRoot);
    expect(resolver.targetsExternalImport(CACHE_GET, mapCtx())).toBe(true);
  });

  // WHICH pass wins for this receiver is not this bead's business — the chain
  // may park the module, pin the project method through a checker pass, or match
  // the short name. The recall claim is only that an edge survives at all, and
  // asserting a particular winner here would pin an unrelated pass's behaviour.
  it("STILL emits an edge for the project-typed imported constant", () => {
    writeProjectTypedConstantFixture(repoRoot);
    const resolver = new TSCallResolver(tsOptions, DEFAULT_AMBIGUOUS_RESOLVE_MODE, repoRoot);
    expect(resolver.resolve(REGISTRY_GET, constantCtx())).not.toBeNull();
  });
});
