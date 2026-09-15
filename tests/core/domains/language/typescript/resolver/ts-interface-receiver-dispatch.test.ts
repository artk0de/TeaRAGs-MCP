import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type CallRef,
  type DispatchEdge,
  type DispatchFanoutOutcome,
  type InheritanceEdgeRow,
  type NamedSymbol,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import {
  TSGlobalShortNameSymbolResolutionStrategy,
  type ResolverConfig,
} from "../../../../../../src/core/domains/language/typescript/resolver/strategies/index.js";
import { TSProgramCache } from "../../../../../../src/core/domains/language/typescript/resolver/ts-program-cache.js";
import { TSCallResolver } from "../../../../../../src/core/domains/language/typescript/resolver/ts-resolver.js";
import { MapHierarchyView } from "../../../../../../src/core/domains/trajectory/codegraph/hierarchy-view.js";
import { buildHierarchySnapshot } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/inheritance-edges.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const tsOptions = { baseUrl: ".", paths: {} };
const cfg: ResolverConfig = { tsOptions, mode: DEFAULT_AMBIGUOUS_RESOLVE_MODE };

function writeSource(repoRoot: string, relPath: string, lines: string[]): void {
  const abs = join(repoRoot, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `${lines.join("\n")}\n`, "utf8");
}

const sym = (symbolId: string, shortName: string, relPath: string, scope: string[]): NamedSymbol => ({
  symbolId,
  fqName: symbolId,
  shortName,
  relPath,
  scope,
});

/** The project's run-global hierarchy, built the way the provider builds it at the pass-1 barrier. */
const hierarchyOf = (implementsEdges: [source: string, ancestor: string][]): MapHierarchyView => {
  const rows: InheritanceEdgeRow[] = implementsEdges.map(([sourceFqName, ancestorFqName], ordinal) => ({
    sourceFqName,
    sourceSymbolId: null,
    ancestorFqName,
    ancestorSymbolId: null,
    kind: "implements",
    ordinal,
  }));
  return new MapHierarchyView(buildHierarchySnapshot(rows));
};

const edgesOf = (outcome: DispatchFanoutOutcome): DispatchEdge[] => {
  if (outcome.kind !== "edges") throw new Error(`expected edges outcome, got ${outcome.kind}`);
  return [...outcome.edges].sort((a, b) => (a.targetSymbolId ?? "").localeCompare(b.targetSymbolId ?? ""));
};

/**
 * The walk-commits shape verbatim, renamed: an interface PORT declared with
 * property signatures, a class that `implements` it, and a caller that pulls the
 * port out of an options object — so the walker records no `localBindings` for
 * the receiver and only the type checker knows what it is.
 */
function writeMemoFixture(repoRoot: string): void {
  writeSource(repoRoot, "src/memo-port.ts", [
    `export interface MemoPort {`,
    `  get: (key: string) => number[] | undefined;`,
    `  set: (key: string, value: number[]) => void;`,
    `}`,
  ]);
  writeSource(repoRoot, "src/memo.ts", [
    `import type { MemoPort } from "./memo-port.js";`,
    ``,
    `export class Memo implements MemoPort {`,
    `  get(key: string): number[] | undefined {`,
    `    return key.length > 0 ? [] : undefined;`,
    `  }`,
    ``,
    `  set(key: string, value: number[]): void {`,
    `    void key;`,
    `    void value;`,
    `  }`,
    `}`,
  ]);
  writeSource(repoRoot, "src/run-memo.ts", [
    `export class RunMemo<K extends object, V> {`,
    `  get(scope: object | undefined, key: K): V | undefined {`,
    `    void scope;`,
    `    void key;`,
    `    return undefined;`,
    `  }`,
    ``,
    `  set(scope: object | undefined, key: K, value: V): void {`,
    `    void scope;`,
    `    void key;`,
    `    void value;`,
    `  }`,
    `}`,
  ]);
  writeSource(repoRoot, "src/walk.ts", [
    `import type { MemoPort } from "./memo-port.js";`,
    ``,
    `export interface WalkOptions {`,
    `  memo?: MemoPort;`,
    `}`,
    ``,
    `export function walk(opts: WalkOptions): number[] | undefined {`,
    `  const { memo } = opts;`,
    `  memo?.set("a", []);`,
    `  return memo?.get("a");`,
    `}`,
  ]);
}

const SET_CALL: CallRef = { callText: `memo?.set("a", [])`, receiver: "memo", member: "set", startLine: 9 };
const GET_CALL: CallRef = { callText: `memo?.get("a")`, receiver: "memo", member: "get", startLine: 10 };

const MEMO_PORT_SYMBOL = sym("MemoPort", "MemoPort", "src/memo-port.ts", []);
const MEMO_SYMBOLS = [
  sym("Memo", "Memo", "src/memo.ts", []),
  sym("Memo#get", "get", "src/memo.ts", ["Memo"]),
  sym("Memo#set", "set", "src/memo.ts", ["Memo"]),
];
const RUN_MEMO_SYMBOLS = [
  sym("RunMemo", "RunMemo", "src/run-memo.ts", []),
  sym("RunMemo#get", "get", "src/run-memo.ts", ["RunMemo"]),
  sym("RunMemo#set", "set", "src/run-memo.ts", ["RunMemo"]),
];

const walkCtx = (table: InMemoryGlobalSymbolTable, over: Partial<CallContext> = {}): CallContext => ({
  callerFile: "src/walk.ts",
  callerScope: ["walk"],
  imports: [{ importText: "./memo-port.js", startLine: 1, importedNames: ["MemoPort"] }],
  symbolTable: table,
  hierarchy: hierarchyOf([["Memo", "MemoPort"]]),
  ...over,
});

const edgeTo = (targetRelPath: string, targetSymbolId: string, confidence: number): DispatchEdge => ({
  sourceSymbolId: null,
  targetRelPath,
  targetSymbolId,
  edgeKind: "cone",
  confidence,
});

/**
 * bd tea-rags-mcp-hwwtw — a member call on a receiver the checker types as a
 * PROJECT INTERFACE is decided by that interface, never by how many methods of
 * the same short name the project happens to declare.
 *
 * Before: `walkCommits` resolved `diffMemo?.set(...)` to `CommitDiffMemo#set`
 * only while `set` had ONE project definition, through `globalShortName`. When
 * bd 39xca.6 added `RunScopedMemo#set` every such edge vanished, and the same
 * pass manufactured edges for a plain `Map#set` in a `.js` spike. The CHA cone
 * already knows how to reach an interface's implementers — it only ever lacked
 * the base type, because the walker binds none for a destructured receiver.
 */
describe("TSCallResolver.resolveDispatch — checker-typed interface receiver (bd tea-rags-mcp-hwwtw)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-interface-receiver-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const resolver = (): TSCallResolver => new TSCallResolver(tsOptions, DEFAULT_AMBIGUOUS_RESOLVE_MODE, repoRoot);

  it("resolves memo?.set to the implementing class even when an unrelated namesake set exists", () => {
    writeMemoFixture(repoRoot);
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("src/memo-port.ts", [MEMO_PORT_SYMBOL]);
    table.upsertFile("src/memo.ts", MEMO_SYMBOLS);
    table.upsertFile("src/run-memo.ts", RUN_MEMO_SYMBOLS);

    expect(edgesOf(resolver().resolveDispatch(SET_CALL, walkCtx(table)))).toEqual([
      edgeTo("src/memo.ts", "Memo#set", 1),
    ]);
  });

  it("resolves memo?.get to the implementing class through the same interface", () => {
    writeMemoFixture(repoRoot);
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("src/memo-port.ts", [MEMO_PORT_SYMBOL]);
    table.upsertFile("src/memo.ts", MEMO_SYMBOLS);
    table.upsertFile("src/run-memo.ts", RUN_MEMO_SYMBOLS);

    expect(edgesOf(resolver().resolveDispatch(GET_CALL, walkCtx(table)))).toEqual([
      edgeTo("src/memo.ts", "Memo#get", 1),
    ]);
  });

  it("gives the same answer when set is the only project method of that name — uniqueness is not the evidence", () => {
    writeMemoFixture(repoRoot);
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("src/memo-port.ts", [MEMO_PORT_SYMBOL]);
    table.upsertFile("src/memo.ts", MEMO_SYMBOLS);

    expect(edgesOf(resolver().resolveDispatch(SET_CALL, walkCtx(table)))).toEqual([
      edgeTo("src/memo.ts", "Memo#set", 1),
    ]);
  });

  it("fans a union of project interfaces out to every implementer, splitting unit weight", () => {
    writeMemoFixture(repoRoot);
    writeSource(repoRoot, "src/other-port.ts", [
      `export interface OtherPort {`,
      `  set: (key: string, value: number[]) => void;`,
      `}`,
    ]);
    writeSource(repoRoot, "src/other-memo.ts", [
      `import type { OtherPort } from "./other-port.js";`,
      ``,
      `export class OtherMemo implements OtherPort {`,
      `  set(key: string, value: number[]): void {`,
      `    void key;`,
      `    void value;`,
      `  }`,
      `}`,
    ]);
    writeSource(repoRoot, "src/walk-either.ts", [
      `import type { MemoPort } from "./memo-port.js";`,
      `import type { OtherPort } from "./other-port.js";`,
      ``,
      `export function walkEither(port: MemoPort | OtherPort): void {`,
      `  port.set("a", []);`,
      `}`,
    ]);
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("src/memo-port.ts", [MEMO_PORT_SYMBOL]);
    table.upsertFile("src/other-port.ts", [sym("OtherPort", "OtherPort", "src/other-port.ts", [])]);
    table.upsertFile("src/memo.ts", MEMO_SYMBOLS);
    table.upsertFile("src/other-memo.ts", [
      sym("OtherMemo", "OtherMemo", "src/other-memo.ts", []),
      sym("OtherMemo#set", "set", "src/other-memo.ts", ["OtherMemo"]),
    ]);
    table.upsertFile("src/run-memo.ts", RUN_MEMO_SYMBOLS);
    const call: CallRef = { callText: `port.set("a", [])`, receiver: "port", member: "set", startLine: 5 };

    const outcome = resolver().resolveDispatch(
      call,
      walkCtx(table, {
        callerFile: "src/walk-either.ts",
        callerScope: ["walkEither"],
        hierarchy: hierarchyOf([
          ["Memo", "MemoPort"],
          ["OtherMemo", "OtherPort"],
        ]),
      }),
    );

    expect(edgesOf(outcome)).toEqual([
      edgeTo("src/memo.ts", "Memo#set", 0.5),
      edgeTo("src/other-memo.ts", "OtherMemo#set", 0.5),
    ]);
  });

  it("keeps the pre-existing answer when the type checker is disabled (CODEGRAPH_TS_TYPECHECKER=0)", () => {
    writeMemoFixture(repoRoot);
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("src/memo-port.ts", [MEMO_PORT_SYMBOL]);
    table.upsertFile("src/memo.ts", MEMO_SYMBOLS);
    table.upsertFile("src/run-memo.ts", RUN_MEMO_SYMBOLS);
    const previous = process.env.CODEGRAPH_TS_TYPECHECKER;
    process.env.CODEGRAPH_TS_TYPECHECKER = "0";
    try {
      expect(edgesOf(resolver().resolveDispatch(SET_CALL, walkCtx(table)))).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.CODEGRAPH_TS_TYPECHECKER;
      else process.env.CODEGRAPH_TS_TYPECHECKER = previous;
    }
  });
});

/**
 * bd tea-rags-mcp-hwwtw — the precision half. With the interface declared but
 * no project class implementing it, the only `set` in the project belongs to an
 * unrelated class; a receiver-blind short-name match would commit to it.
 */
describe("TSGlobalShortNameSymbolResolutionStrategy — interface-typed receiver (bd tea-rags-mcp-hwwtw)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-interface-receiver-guard-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function writeLonelyPortFixture(): void {
    writeMemoFixture(repoRoot);
    writeSource(repoRoot, "src/lonely.ts", [
      `import type { MemoPort } from "./memo-port.js";`,
      ``,
      `export function lonely(opts: { memo: MemoPort }): void {`,
      `  const { memo } = opts;`,
      `  memo.set("a", []);`,
      `}`,
    ]);
  }

  const LONELY_CALL: CallRef = { callText: `memo.set("a", [])`, receiver: "memo", member: "set", startLine: 5 };

  const lonelyCtx = (): CallContext => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("src/memo-port.ts", [MEMO_PORT_SYMBOL]);
    table.upsertFile(
      "src/run-memo.ts",
      RUN_MEMO_SYMBOLS.filter((s) => s.shortName !== "get"),
    );
    return walkCtx(table, { callerFile: "src/lonely.ts", callerScope: ["lonely"], hierarchy: hierarchyOf([]) });
  };

  it("continues instead of matching the project's only set on an unrelated class", () => {
    writeLonelyPortFixture();
    const strategy = new TSGlobalShortNameSymbolResolutionStrategy(cfg, new TSProgramCache({ repoRoot, tsOptions }));
    expect(strategy.attempt(LONELY_CALL, lonelyCtx()).kind).toBe("continue");
  });

  it("emits no method edge end to end — the member is only known to be declared on the interface", () => {
    writeLonelyPortFixture();
    const resolver = new TSCallResolver(tsOptions, DEFAULT_AMBIGUOUS_RESOLVE_MODE, repoRoot);
    const ctx = lonelyCtx();
    expect(edgesOf(resolver.resolveDispatch(LONELY_CALL, ctx))).toEqual([]);
    expect(resolver.resolve(LONELY_CALL, ctx)).toEqual({ targetRelPath: "src/memo-port.ts", targetSymbolId: null });
  });
});

/**
 * bd tea-rags-mcp-hwwtw, rule 2 — a receiver the checker types as a runtime
 * builtin never reaches a project method, even when the member's short name is
 * unique in the project. Pinned beside the interface cases because it is the
 * same question with the other answer: the declared type decides, in both
 * directions.
 */
describe("TSCallResolver — builtin-typed receiver with a uniquely named project method (bd tea-rags-mcp-hwwtw)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-builtin-receiver-unique-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("emits no edge for cache.set on a destructured Map", () => {
    writeMemoFixture(repoRoot);
    writeSource(repoRoot, "src/remember.ts", [
      `export interface RememberOptions {`,
      `  cache: Map<string, number>;`,
      `}`,
      ``,
      `export function remember(opts: RememberOptions): void {`,
      `  const { cache } = opts;`,
      `  cache.set("a", 1);`,
      `}`,
    ]);
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile(
      "src/memo.ts",
      MEMO_SYMBOLS.filter((s) => s.shortName !== "get"),
    );
    const call: CallRef = { callText: `cache.set("a", 1)`, receiver: "cache", member: "set", startLine: 7 };
    const ctx: CallContext = {
      callerFile: "src/remember.ts",
      callerScope: ["remember"],
      imports: [],
      symbolTable: table,
      hierarchy: hierarchyOf([["Memo", "MemoPort"]]),
    };

    const resolver = new TSCallResolver(tsOptions, DEFAULT_AMBIGUOUS_RESOLVE_MODE, repoRoot);
    expect(edgesOf(resolver.resolveDispatch(call, ctx))).toEqual([]);
    expect(resolver.resolve(call, ctx)).toBeNull();
    expect(
      new TSGlobalShortNameSymbolResolutionStrategy(cfg, new TSProgramCache({ repoRoot, tsOptions })).attempt(call, ctx)
        .kind,
    ).toBe("continue");
  });
});
