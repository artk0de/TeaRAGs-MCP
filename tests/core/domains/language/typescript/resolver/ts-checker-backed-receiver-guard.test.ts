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
  TSImportNarrowedFallbackSymbolResolutionStrategy,
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
 * The project owns exactly ONE symbol per builtin-colliding short name, which is
 * what makes `globalShortName` confident enough to fabricate: `set` / `next` /
 * `toString` each resolve to a single project method under strict mode.
 */
const collidingTable = (): InMemoryGlobalSymbolTable => {
  const table = new InMemoryGlobalSymbolTable();
  table.upsertFile("src/memo.ts", [sym("CommitDiffMemo#set", "set", "src/memo.ts", ["CommitDiffMemo"])]);
  table.upsertFile("src/cursor.ts", [sym("ChunkCursor#next", "next", "src/cursor.ts", ["ChunkCursor"])]);
  table.upsertFile("src/error.ts", [sym("TeaRagsError#toString", "toString", "src/error.ts", ["TeaRagsError"])]);
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
 * `collection-registry.ts` — the `.set()` mass root cause 2 named. The Map comes
 * from a CALL (`this.ensureLoaded()`), so the walker binds no type to `map` and
 * `set` is deliberately outside the last-resort vocabulary.
 */
function writeCallResultMapFixture(repoRoot: string): void {
  writeSource(
    repoRoot,
    "src/collection-registry.ts",
    [
      `export interface CollectionEntry {`,
      `  path: string;`,
      `}`,
      ``,
      `export class CollectionRegistry {`,
      `  private cache: Map<string, CollectionEntry> | null = null;`,
      ``,
      `  ensureLoaded() {`,
      `    if (this.cache === null) this.cache = new Map<string, CollectionEntry>();`,
      `    return this.cache;`,
      `  }`,
      ``,
      `  register(name: string, entry: CollectionEntry): void {`,
      `    const map = this.ensureLoaded();`,
      `    map.set(name, entry);`,
      `  }`,
      `}`,
      ``,
    ].join("\n"),
  );
}

const CALL_RESULT_MAP_SET: CallRef = {
  callText: "map.set(name, entry)",
  receiver: "map",
  member: "set",
  startLine: 15,
};

/**
 * `enrichment/infra/worker.ts` — a module-level `const … = new Map()`. No
 * annotation to read, so the walker records nothing; the constructor is the only
 * evidence and only the checker sees it.
 */
function writeModuleConstMapFixture(repoRoot: string): void {
  writeSource(
    repoRoot,
    "src/worker.ts",
    [
      `const providerCache = new Map<string, Promise<string>>();`,
      ``,
      `export function remember(key: string, pending: Promise<string>): void {`,
      `  providerCache.set(key, pending);`,
      `}`,
      ``,
    ].join("\n"),
  );
}

const MODULE_CONST_MAP_SET: CallRef = {
  callText: "providerCache.set(key, pending)",
  receiver: "providerCache",
  member: "set",
  startLine: 4,
};

/**
 * `sync/parallel-synchronizer.ts:216` — a field annotated `Map<…> | null`. The
 * union annotation defeats `extractTypeNameFromAnnotation`, so the walker binds
 * nothing; the checker reports the bare `Map`, because the Programs the guard
 * reads are built without `strictNullChecks` and absorb the `null`.
 */
function writeUnionFieldMapFixture(repoRoot: string): void {
  writeSource(
    repoRoot,
    "src/parallel-synchronizer.ts",
    [
      `export interface FileMetadata {`,
      `  hash: string;`,
      `}`,
      ``,
      `export class ParallelSynchronizer {`,
      `  private lastComputedHashes: Map<string, FileMetadata> | null = null;`,
      ``,
      `  record(entries: [string, FileMetadata][]): void {`,
      `    this.lastComputedHashes = new Map<string, FileMetadata>();`,
      `    entries.forEach(([path, meta]) => {`,
      `      this.lastComputedHashes.set(path, meta);`,
      `    });`,
      `  }`,
      `}`,
      ``,
    ].join("\n"),
  );
}

const UNION_FIELD_MAP_SET: CallRef = {
  callText: "this.lastComputedHashes.set(path, meta)",
  receiver: "this.lastComputedHashes",
  member: "set",
  startLine: 11,
};

/**
 * `debug-log-format.ts:41` — root cause 3's primitive arm. `seconds` is typed
 * only by the arithmetic that produced it; its apparent type is `Number`.
 */
function writePrimitiveToStringFixture(repoRoot: string): void {
  writeSource(
    repoRoot,
    "src/debug-log-format.ts",
    [
      `export function formatElapsed(startedAt: number): string {`,
      `  const seconds = (Date.now() - startedAt) / 1000;`,
      `  return seconds.toString();`,
      `}`,
      ``,
    ].join("\n"),
  );
}

const PRIMITIVE_TO_STRING: CallRef = {
  callText: "seconds.toString()",
  receiver: "seconds",
  member: "toString",
  startLine: 3,
};

/**
 * The recall guard for every case above: the SAME untyped-by-the-walker shape,
 * except the checker names a PROJECT class. Nothing here may be declined.
 */
function writeProjectTypedReceiverFixture(repoRoot: string): void {
  writeSource(
    repoRoot,
    "src/memo.ts",
    [
      `export class CommitDiffMemo {`,
      `  set(key: string, value: number): void {`,
      `    void key;`,
      `    void value;`,
      `  }`,
      `}`,
      ``,
      `export function makeMemo() {`,
      `  return new CommitDiffMemo();`,
      `}`,
      ``,
    ].join("\n"),
  );
  writeSource(
    repoRoot,
    "src/memo-caller.ts",
    [
      `import { makeMemo } from "./memo.js";`,
      ``,
      `export function run(): void {`,
      `  const memo = makeMemo();`,
      `  memo.set("a", 1);`,
      `}`,
      ``,
    ].join("\n"),
  );
}

const PROJECT_TYPED_SET: CallRef = { callText: 'memo.set("a", 1)', receiver: "memo", member: "set", startLine: 5 };

/**
 * bd tea-rags-mcp-335eu — root causes 2 and 3 of bd tea-rags-mcp-yjqi5.
 *
 * `receiverIsExternalInstance` decides on the WALKER's type hints, and falls
 * through to {@link ECMASCRIPT_BUILTIN_PROTOTYPE_METHODS} when there are none.
 * That vocabulary deliberately excludes `set` / `next` / `toString`, because a
 * project method is just as likely to carry those names — so a receiver the
 * walker could not type reached `globalShortName` with no type evidence at all
 * and matched whatever single project symbol shared the member name.
 *
 * The type IS knowable for exactly these receivers; only not by the walker. Four
 * chain passes already hold a {@link TSProgramCache}, and this guard now shares
 * it as a LAST-RESORT arm: consulted only where `receiverTypeName` returned
 * nothing, and only able to say "external", never "internal". A checker answer
 * that is not a builtin leaves the vocabulary's verdict exactly as it was.
 */
describe("TSGlobalShortNameSymbolResolutionStrategy — checker-backed receiver guard (bd tea-rags-mcp-335eu)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-checker-guard-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const strategy = (): TSGlobalShortNameSymbolResolutionStrategy =>
    new TSGlobalShortNameSymbolResolutionStrategy(cfg, new TSProgramCache({ repoRoot, tsOptions }));

  it("continues for a Map obtained from a call (collection-registry.ts map.set(name, entry))", () => {
    writeCallResultMapFixture(repoRoot);
    const outcome = strategy().attempt(CALL_RESULT_MAP_SET, ctx("src/collection-registry.ts"));
    expect(outcome.kind).toBe("continue");
  });

  it("continues for a module-level `new Map()` constant (worker.ts providerCache.set(key, pending))", () => {
    writeModuleConstMapFixture(repoRoot);
    const outcome = strategy().attempt(MODULE_CONST_MAP_SET, ctx("src/worker.ts"));
    expect(outcome.kind).toBe("continue");
  });

  it("continues for a `Map | null` field the union annotation hid (parallel-synchronizer.ts:216)", () => {
    writeUnionFieldMapFixture(repoRoot);
    const outcome = strategy().attempt(UNION_FIELD_MAP_SET, ctx("src/parallel-synchronizer.ts"));
    expect(outcome.kind).toBe("continue");
  });

  it("continues for a primitive receiver typed only by arithmetic (debug-log-format.ts seconds.toString())", () => {
    writePrimitiveToStringFixture(repoRoot);
    const outcome = strategy().attempt(PRIMITIVE_TO_STRING, ctx("src/debug-log-format.ts"));
    expect(outcome.kind).toBe("continue");
  });

  it("STILL resolves when the checker names a PROJECT class for the same untyped shape (memo.set)", () => {
    writeProjectTypedReceiverFixture(repoRoot);
    const outcome = strategy().attempt(
      PROJECT_TYPED_SET,
      ctx("src/memo-caller.ts", { imports: [{ importText: "./memo.js", startLine: 1, importedNames: ["makeMemo"] }] }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/memo.ts", targetSymbolId: "CommitDiffMemo#set" },
    });
  });

  it("STILL resolves when no Program can be built for the caller file (nothing on disk)", () => {
    const outcome = strategy().attempt(CALL_RESULT_MAP_SET, ctx("src/collection-registry.ts"));
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/memo.ts", targetSymbolId: "CommitDiffMemo#set" },
    });
  });

  it("continues for a union whose every constituent is a builtin (Map | Set)", () => {
    writeSource(
      repoRoot,
      "src/union-param.ts",
      [
        `export function record(cache: Map<string, number> | Set<string>, key: string): void {`,
        `  cache.add = cache.add;`,
        `  cache.set(key, 1);`,
        `}`,
        ``,
      ].join("\n"),
    );
    const call: CallRef = { callText: "cache.set(key, 1)", receiver: "cache", member: "set", startLine: 3 };
    expect(strategy().attempt(call, ctx("src/union-param.ts")).kind).toBe("continue");
  });

  it("STILL resolves for a union mixing a builtin with a PROJECT type (Map | CommitDiffMemo)", () => {
    writeSource(
      repoRoot,
      "src/memo.ts",
      [
        `export class CommitDiffMemo {`,
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
      "src/union-mixed.ts",
      [
        `import { CommitDiffMemo } from "./memo.js";`,
        ``,
        `export function record(store: Map<string, number> | CommitDiffMemo, key: string): void {`,
        `  store.set(key, 1);`,
        `}`,
        ``,
      ].join("\n"),
    );
    const call: CallRef = { callText: "store.set(key, 1)", receiver: "store", member: "set", startLine: 4 };
    expect(
      strategy().attempt(
        call,
        ctx("src/union-mixed.ts", {
          imports: [{ importText: "./memo.js", startLine: 1, importedNames: ["CommitDiffMemo"] }],
        }),
      ),
    ).toEqual({ kind: "resolved", target: { targetRelPath: "src/memo.ts", targetSymbolId: "CommitDiffMemo#set" } });
  });

  it("STILL resolves when the PROJECT declares its own `class Map` — the name alone never decides", () => {
    writeSource(
      repoRoot,
      "src/own-map.ts",
      [
        `export class Map {`,
        `  set(key: string, value: number): void {`,
        `    void key;`,
        `    void value;`,
        `  }`,
        `}`,
        ``,
        `export function run(m: Map): void {`,
        `  m.set("a", 1);`,
        `}`,
        ``,
      ].join("\n"),
    );
    const call: CallRef = { callText: 'm.set("a", 1)', receiver: "m", member: "set", startLine: 9 };
    expect(strategy().attempt(call, ctx("src/own-map.ts"))).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/memo.ts", targetSymbolId: "CommitDiffMemo#set" },
    });
  });

  it("STILL resolves when the recorded line holds no such call — a node it cannot locate decides nothing", () => {
    writeCallResultMapFixture(repoRoot);
    const call: CallRef = { ...CALL_RESULT_MAP_SET, startLine: 8 };
    expect(strategy().attempt(call, ctx("src/collection-registry.ts"))).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/memo.ts", targetSymbolId: "CommitDiffMemo#set" },
    });
  });

  it("behaves exactly as before when no Program cache is injected (the disabled state)", () => {
    writeCallResultMapFixture(repoRoot);
    const outcome = new TSGlobalShortNameSymbolResolutionStrategy(cfg, null).attempt(
      CALL_RESULT_MAP_SET,
      ctx("src/collection-registry.ts"),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/memo.ts", targetSymbolId: "CommitDiffMemo#set" },
    });
  });
});

/**
 * bd tea-rags-mcp-335eu — the import-narrowed sibling shares the guard, and
 * needs it more: narrowing an ambiguous member name by the caller's imports
 * turns a guess into a confident answer.
 */
describe("TSImportNarrowedFallbackSymbolResolutionStrategy — checker-backed receiver guard (bd tea-rags-mcp-335eu)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-checker-guard-narrowed-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  /** Two project `set`s, one of them in a file the caller imports — the narrowing shape. */
  const ambiguousTable = (): InMemoryGlobalSymbolTable => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("src/memo.ts", [sym("CommitDiffMemo#set", "set", "src/memo.ts", ["CommitDiffMemo"])]);
    table.upsertFile("src/other.ts", [sym("OtherStore#set", "set", "src/other.ts", ["OtherStore"])]);
    return table;
  };

  it("continues for a Map obtained from a call rather than narrowing to the imported `set`", () => {
    writeCallResultMapFixture(repoRoot);
    writeSource(repoRoot, "src/memo.ts", [`export class CommitDiffMemo {}`, ``].join("\n"));

    const outcome = new TSImportNarrowedFallbackSymbolResolutionStrategy(
      cfg,
      new TSProgramCache({ repoRoot, tsOptions }),
    ).attempt(
      CALL_RESULT_MAP_SET,
      ctx("src/collection-registry.ts", {
        symbolTable: ambiguousTable(),
        imports: [{ importText: "./memo.js", startLine: 1, importedNames: ["CommitDiffMemo"] }],
      }),
    );

    expect(outcome.kind).toBe("continue");
  });
});

/**
 * bd tea-rags-mcp-335eu — the same decision through the whole chain, plus the
 * classifier half. A call declined BECAUSE it targets `Map.prototype.set` must
 * also leave the internal `resolveSuccessRate` denominator, or the resolver is
 * penalised for being right.
 */
describe("TSCallResolver — checker-backed receiver guard end to end (bd tea-rags-mcp-335eu)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-checker-guard-e2e-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("emits no edge for map.set(name, entry) on a call-result Map", () => {
    writeCallResultMapFixture(repoRoot);
    const resolver = new TSCallResolver(tsOptions, DEFAULT_AMBIGUOUS_RESOLVE_MODE, repoRoot);
    expect(resolver.resolve(CALL_RESULT_MAP_SET, ctx("src/collection-registry.ts"))).toBeNull();
  });

  it("counts that same call as external so it leaves the resolveSuccessRate denominator", () => {
    writeCallResultMapFixture(repoRoot);
    const resolver = new TSCallResolver(tsOptions, DEFAULT_AMBIGUOUS_RESOLVE_MODE, repoRoot);
    expect(resolver.targetsExternalImport(CALL_RESULT_MAP_SET, ctx("src/collection-registry.ts"))).toBe(true);
  });

  it("STILL emits the real edge when the checker names a project class (memo.set)", () => {
    writeProjectTypedReceiverFixture(repoRoot);
    const resolver = new TSCallResolver(tsOptions, DEFAULT_AMBIGUOUS_RESOLVE_MODE, repoRoot);
    expect(
      resolver.resolve(
        PROJECT_TYPED_SET,
        ctx("src/memo-caller.ts", {
          imports: [{ importText: "./memo.js", startLine: 1, importedNames: ["makeMemo"] }],
        }),
      ),
    ).toEqual({ targetRelPath: "src/memo.ts", targetSymbolId: "CommitDiffMemo#set" });
  });

  it("CODEGRAPH_TS_TYPECHECKER=0 keeps the guard exactly as it was — no checker involvement", () => {
    writeCallResultMapFixture(repoRoot);
    const previous = process.env.CODEGRAPH_TS_TYPECHECKER;
    process.env.CODEGRAPH_TS_TYPECHECKER = "0";
    try {
      const resolver = new TSCallResolver(tsOptions, DEFAULT_AMBIGUOUS_RESOLVE_MODE, repoRoot);
      expect(resolver.programCache).toBeNull();
      expect(resolver.resolve(CALL_RESULT_MAP_SET, ctx("src/collection-registry.ts"))).toEqual({
        targetRelPath: "src/memo.ts",
        targetSymbolId: "CommitDiffMemo#set",
      });
      expect(resolver.targetsExternalImport(CALL_RESULT_MAP_SET, ctx("src/collection-registry.ts"))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.CODEGRAPH_TS_TYPECHECKER;
      else process.env.CODEGRAPH_TS_TYPECHECKER = previous;
    }
  });
});
