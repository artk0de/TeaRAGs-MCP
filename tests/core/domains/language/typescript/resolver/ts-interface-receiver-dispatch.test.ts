import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import Parser from "tree-sitter";
import TsLang from "tree-sitter-typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type CallRef,
  type DispatchEdge,
  type DispatchFanoutOutcome,
  type InheritanceEdgeRow,
  type SymbolDefinition,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/index.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { tsNameOf, TypeScriptLanguage } from "../../../../../../src/core/domains/language/typescript/index.js";
import {
  TSGlobalShortNameSymbolResolutionStrategy,
  type ResolverConfig,
} from "../../../../../../src/core/domains/language/typescript/resolver/strategies/index.js";
import { interfaceReceiverExcludesCandidate } from "../../../../../../src/core/domains/language/typescript/resolver/ts-interface-receiver.js";
import { TSProgramCache } from "../../../../../../src/core/domains/language/typescript/resolver/ts-program-cache.js";
import { TSCallResolver } from "../../../../../../src/core/domains/language/typescript/resolver/ts-resolver.js";
import { extractFromTypescriptFile } from "../../../../../../src/core/domains/language/typescript/walker/walker.js";
import { MapHierarchyView } from "../../../../../../src/core/domains/trajectory/codegraph/hierarchy-view.js";
import { buildHierarchySnapshot } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/inheritance-edges.js";
import { symbolDefinitionsOf } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-definitions.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { materializeTree } from "../../../../../../src/core/infra/materialize.js";

const tsOptions = { baseUrl: ".", paths: {} };
const cfg: ResolverConfig = { tsOptions, mode: DEFAULT_AMBIGUOUS_RESOLVE_MODE };

function writeSource(repoRoot: string, relPath: string, lines: string[]): void {
  const abs = join(repoRoot, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `${lines.join("\n")}\n`, "utf8");
}

const sym = (symbolId: string, shortName: string, relPath: string, scope: string[]): SymbolDefinition => ({
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

/**
 * What the walker records for `memo-port.ts`: the FILE, and no symbol in it.
 * `tsNameOf` names classes, functions and methods, never an
 * `interface_declaration`, so `MemoPort` is no table row (bd
 * tea-rags-mcp-t5cji). The receiver is an interface to the checker alone, and
 * the cone reaches `Memo` through the run hierarchy's `implements` edge.
 */
const MEMO_PORT_SYMBOLS: SymbolDefinition[] = [];
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
    table.upsertFile("src/memo-port.ts", MEMO_PORT_SYMBOLS);
    table.upsertFile("src/memo.ts", MEMO_SYMBOLS);
    table.upsertFile("src/run-memo.ts", RUN_MEMO_SYMBOLS);

    expect(edgesOf(resolver().resolveDispatch(SET_CALL, walkCtx(table)))).toEqual([
      edgeTo("src/memo.ts", "Memo#set", 1),
    ]);
  });

  it("resolves memo?.get to the implementing class through the same interface", () => {
    writeMemoFixture(repoRoot);
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("src/memo-port.ts", MEMO_PORT_SYMBOLS);
    table.upsertFile("src/memo.ts", MEMO_SYMBOLS);
    table.upsertFile("src/run-memo.ts", RUN_MEMO_SYMBOLS);

    expect(edgesOf(resolver().resolveDispatch(GET_CALL, walkCtx(table)))).toEqual([
      edgeTo("src/memo.ts", "Memo#get", 1),
    ]);
  });

  it("gives the same answer when set is the only project method of that name — uniqueness is not the evidence", () => {
    writeMemoFixture(repoRoot);
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("src/memo-port.ts", MEMO_PORT_SYMBOLS);
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
    table.upsertFile("src/memo-port.ts", MEMO_PORT_SYMBOLS);
    // Interface-only, like memo-port.ts: the file is recorded, `OtherPort` is not.
    table.upsertFile("src/other-port.ts", []);
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
    table.upsertFile("src/memo-port.ts", MEMO_PORT_SYMBOLS);
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
    table.upsertFile("src/memo-port.ts", MEMO_PORT_SYMBOLS);
    table.upsertFile(
      "src/run-memo.ts",
      RUN_MEMO_SYMBOLS.filter((s) => s.shortName !== "get"),
    );
    return walkCtx(table, { callerFile: "src/lonely.ts", callerScope: ["lonely"], hierarchy: hierarchyOf([]) });
  };

  /**
   * The hwwtw guard's own verdict, asserted beside each outcome (bd
   * tea-rags-mcp-t5cji): the member-evidence guard declines the same candidate
   * after this one, so the outcome alone no longer shows this guard spoke.
   */
  const RUN_MEMO_SET = RUN_MEMO_SYMBOLS.find((s) => s.symbolId === "RunMemo#set") as SymbolDefinition;

  it("continues instead of matching the project's only set on an unrelated class", () => {
    writeLonelyPortFixture();
    const cache = new TSProgramCache({ repoRoot, tsOptions });
    expect(interfaceReceiverExcludesCandidate(LONELY_CALL, lonelyCtx(), cache, RUN_MEMO_SET)).toBe(true);
    const strategy = new TSGlobalShortNameSymbolResolutionStrategy(cfg, cache);
    expect(strategy.attempt(LONELY_CALL, lonelyCtx()).kind).toBe("continue");
  });

  it("emits no method edge end to end — the member is only known to be declared on the interface", () => {
    writeLonelyPortFixture();
    const resolver = new TSCallResolver(tsOptions, DEFAULT_AMBIGUOUS_RESOLVE_MODE, repoRoot);
    expect(interfaceReceiverExcludesCandidate(LONELY_CALL, lonelyCtx(), resolver.programCache, RUN_MEMO_SET)).toBe(
      true,
    );
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

/**
 * bd tea-rags-mcp-39xca.14 — a class that satisfies the interface WITHOUT an
 * `implements` clause is a structural descendant. The barrier derives the row
 * from the interface's contract and the symbol table, and the same cone reaches
 * the implementer. `RunMemo` carries both names too, but requires more
 * arguments than the port passes, so it never conforms.
 */
describe("TSCallResolver.resolveDispatch — structural implementer of a checker-typed interface (bd 39xca.14)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-structural-receiver-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const arity = (minRequired: number, maxPositional: number) => ({ minRequired, maxPositional, hasSplat: false });

  it("fans memo?.set out to the class that conforms without implements, and not to one requiring more arguments", () => {
    writeMemoFixture(repoRoot);
    // `Memo` drops its `implements` clause: only structure connects it now.
    writeSource(repoRoot, "src/memo.ts", [
      `export class Memo {`,
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
    const memo = [
      sym("Memo", "Memo", "src/memo.ts", []),
      { ...sym("Memo#get", "get", "src/memo.ts", ["Memo"]), arity: arity(1, 1) },
      { ...sym("Memo#set", "set", "src/memo.ts", ["Memo"]), arity: arity(2, 2) },
    ];
    const runMemo = [
      sym("RunMemo", "RunMemo", "src/run-memo.ts", []),
      { ...sym("RunMemo#get", "get", "src/run-memo.ts", ["RunMemo"]), arity: arity(2, 2) },
      { ...sym("RunMemo#set", "set", "src/run-memo.ts", ["RunMemo"]), arity: arity(3, 3) },
    ];
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("src/memo-port.ts", MEMO_PORT_SYMBOLS);
    table.upsertFile("src/memo.ts", memo);
    table.upsertFile("src/run-memo.ts", runMemo);
    const structuralRows = new TypeScriptLanguage().structuralConformance({
      contracts: [
        {
          name: "MemoPort",
          members: [
            { name: "get", params: 1 },
            { name: "set", params: 2 },
          ],
        },
      ],
      memberDefinitions: [...table.lookupByShortName("get"), ...table.lookupByShortName("set")],
      nominalRows: [],
    });

    const ctx = walkCtx(table, { hierarchy: new MapHierarchyView(buildHierarchySnapshot(structuralRows)) });

    expect(structuralRows.map((row) => `${row.sourceFqName} ${row.kind} ${row.ancestorFqName}`)).toEqual([
      "Memo structural MemoPort",
    ]);
    expect(edgesOf(resolver(repoRoot).resolveDispatch(SET_CALL, ctx))).toEqual([edgeTo("src/memo.ts", "Memo#set", 1)]);
  });

  const resolver = (root: string): TSCallResolver =>
    new TSCallResolver(tsOptions, DEFAULT_AMBIGUOUS_RESOLVE_MODE, root);
});

/**
 * bd tea-rags-mcp-39xca.19 — an object-literal factory's members are
 * instance-bound (`createDeletionOutcome#isFullSuccess`), and only instance-bound
 * members make an owner conform. The table here is what the WALKER composes for
 * the real source, so the test also fails when the walker drifts back to `.`.
 * A helper nested in a function (`parseSnapshot.close`) is a scope, not a
 * member: `closer?.close()` on a `Closer` must not fan out to it.
 */
describe("TSCallResolver.resolveDispatch — object-literal factory as a structural implementer (bd 39xca.19)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-factory-literal-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const OUTCOME_SOURCE = [
    `export interface DeletionOutcome {`,
    `  markFailed: (path: string) => void;`,
    `  isFullSuccess: () => boolean;`,
    `}`,
    ``,
    `export interface Closer {`,
    `  close: () => void;`,
    `}`,
    ``,
    `export function createDeletionOutcome(attemptedPaths: string[]): DeletionOutcome {`,
    `  const failed = new Set<string>();`,
    `  return {`,
    `    markFailed(path) {`,
    `      if (attemptedPaths.includes(path)) failed.add(path);`,
    `    },`,
    `    isFullSuccess() {`,
    `      return failed.size === 0;`,
    `    },`,
    `  };`,
    `}`,
  ];
  const SCHEMA_SOURCE = [
    `export function parseSnapshot(text: string): string[] {`,
    `  const lines: string[] = [];`,
    `  const close = (): void => {`,
    `    lines.push(text);`,
    `  };`,
    `  close();`,
    `  return lines;`,
    `}`,
  ];
  const USE_SOURCE = [
    `import type { Closer, DeletionOutcome } from "./outcome.js";`,
    ``,
    `export interface UseOptions {`,
    `  outcome?: DeletionOutcome;`,
    `  closer?: Closer;`,
    `}`,
    ``,
    `export function use(opts: UseOptions): boolean {`,
    `  const { outcome, closer } = opts;`,
    `  closer?.close();`,
    `  return outcome?.isFullSuccess() ?? false;`,
    `}`,
  ];

  /** The rows the TypeScript walker composes for `lines`, as symbol-table entries. */
  const walkedSymbols = (relPath: string, lines: string[]): SymbolDefinition[] => {
    const src = `${lines.join("\n")}\n`;
    const parser = new Parser();
    parser.setLanguage(TsLang.typescript);
    const root = materializeTree(parser.parse(src).rootNode, src);
    return collectSymbols({ rootNode: root }, tsNameOf, ".", false, new DefaultSymbolIdComposer()).map((range) =>
      sym(range.symbolId, range.symbolId.split(/[#.]/u).at(-1) ?? range.symbolId, relPath, range.scope),
    );
  };

  it("reaches createDeletionOutcome#isFullSuccess and never a nested helper", () => {
    writeSource(repoRoot, "src/outcome.ts", OUTCOME_SOURCE);
    writeSource(repoRoot, "src/schema.ts", SCHEMA_SOURCE);
    writeSource(repoRoot, "src/use.ts", USE_SOURCE);
    const table = new InMemoryGlobalSymbolTable();
    const outcomeSymbols = walkedSymbols("src/outcome.ts", OUTCOME_SOURCE);
    const schemaSymbols = walkedSymbols("src/schema.ts", SCHEMA_SOURCE);
    table.upsertFile("src/outcome.ts", outcomeSymbols);
    table.upsertFile("src/schema.ts", schemaSymbols);
    table.upsertFile("src/use.ts", walkedSymbols("src/use.ts", USE_SOURCE));
    const structuralRows = new TypeScriptLanguage().structuralConformance({
      contracts: [
        {
          name: "DeletionOutcome",
          members: [
            { name: "markFailed", params: 1 },
            { name: "isFullSuccess", params: 0 },
          ],
        },
        { name: "Closer", members: [{ name: "close", params: 0 }] },
      ],
      memberDefinitions: [...outcomeSymbols, ...schemaSymbols],
      nominalRows: [],
    });
    const ctx: CallContext = {
      callerFile: "src/use.ts",
      callerScope: ["use"],
      imports: [{ importText: "./outcome.js", startLine: 1, importedNames: ["Closer", "DeletionOutcome"] }],
      symbolTable: table,
      hierarchy: new MapHierarchyView(buildHierarchySnapshot(structuralRows)),
    };
    const resolver = new TSCallResolver(tsOptions, DEFAULT_AMBIGUOUS_RESOLVE_MODE, repoRoot);

    expect(structuralRows.map((row) => `${row.sourceFqName} ${row.kind} ${row.ancestorFqName}`)).toEqual([
      "createDeletionOutcome structural DeletionOutcome",
    ]);
    const isFullSuccess: CallRef = {
      callText: "outcome?.isFullSuccess()",
      receiver: "outcome",
      member: "isFullSuccess",
      startLine: 11,
    };
    expect(edgesOf(resolver.resolveDispatch(isFullSuccess, ctx))).toEqual([
      edgeTo("src/outcome.ts", "createDeletionOutcome#isFullSuccess", 1),
    ]);
    const close: CallRef = { callText: "closer?.close()", receiver: "closer", member: "close", startLine: 10 };
    expect(edgesOf(resolver.resolveDispatch(close, ctx))).toEqual([]);
  });

  // Option A (owner, 2026-09-27): an object-literal declarator is itself the
  // value that satisfies the contract, so its `.` member is reached — through
  // the owner kind the WALKER records, while the function's nested `.close`
  // helper still is not.
  it("reaches an object-literal declarator's `.` member and still never a nested helper", () => {
    const CLOSERS_SOURCE = [
      `export const IMMEDIATE_CLOSER = {`,
      `  close(): void {`,
      `    return undefined;`,
      `  },`,
      `};`,
    ];
    writeSource(repoRoot, "src/outcome.ts", OUTCOME_SOURCE);
    writeSource(repoRoot, "src/schema.ts", SCHEMA_SOURCE);
    writeSource(repoRoot, "src/closers.ts", CLOSERS_SOURCE);
    writeSource(repoRoot, "src/use.ts", USE_SOURCE);
    const walkedDefinitions = (relPath: string, lines: string[]): SymbolDefinition[] => {
      const src = `${lines.join("\n")}\n`;
      const parser = new Parser();
      parser.setLanguage(TsLang.typescript);
      const tree = { rootNode: materializeTree(parser.parse(src).rootNode, src) };
      const chunks = collectSymbols(tree, tsNameOf, ".", false, new DefaultSymbolIdComposer());
      return symbolDefinitionsOf(
        extractFromTypescriptFile({ tree, code: src, relPath, language: "typescript", chunks }),
      );
    };
    const table = new InMemoryGlobalSymbolTable();
    const defs = [
      ...walkedDefinitions("src/outcome.ts", OUTCOME_SOURCE),
      ...walkedDefinitions("src/schema.ts", SCHEMA_SOURCE),
      ...walkedDefinitions("src/closers.ts", CLOSERS_SOURCE),
    ];
    for (const relPath of ["src/outcome.ts", "src/schema.ts", "src/closers.ts"]) {
      table.upsertFile(
        relPath,
        defs.filter((def) => def.relPath === relPath),
      );
    }
    const structuralRows = new TypeScriptLanguage().structuralConformance({
      contracts: [{ name: "Closer", members: [{ name: "close", params: 0 }] }],
      memberDefinitions: table.lookupByShortName("close"),
      ownerDefinitions: [...table.lookupByShortName("IMMEDIATE_CLOSER"), ...table.lookupByShortName("parseSnapshot")],
      nominalRows: [],
    });
    const ctx: CallContext = {
      callerFile: "src/use.ts",
      callerScope: ["use"],
      imports: [{ importText: "./outcome.js", startLine: 1, importedNames: ["Closer", "DeletionOutcome"] }],
      symbolTable: table,
      hierarchy: new MapHierarchyView(buildHierarchySnapshot(structuralRows)),
    };
    const resolver = new TSCallResolver(tsOptions, DEFAULT_AMBIGUOUS_RESOLVE_MODE, repoRoot);

    expect(structuralRows.map((row) => `${row.sourceFqName} ${row.kind} ${row.ancestorFqName}`)).toEqual([
      "IMMEDIATE_CLOSER structural Closer",
    ]);
    const close: CallRef = { callText: "closer?.close()", receiver: "closer", member: "close", startLine: 10 };
    expect(edgesOf(resolver.resolveDispatch(close, ctx))).toEqual([
      edgeTo("src/closers.ts", "IMMEDIATE_CLOSER.close", 1),
    ]);
  });
});

/**
 * bd tea-rags-mcp-6ea2k — a contract declared as a TYPE ALIAS of an object type
 * (`export type StorePort = { read…; write… }`) is a contract exactly like an
 * `interface` (39xca.14 design names both). The checker reports such a receiver
 * as an anonymous `__type` whose ALIAS is the contract, and the receiver
 * reader only ever accepted interface declarations, so a `this.local.write()`
 * on a field typed `StorePort` reached no implementer — nominal
 * (`implements StorePort`) or structural. The taxdome prototypes/state
 * `StorageAdapter` shape, renamed.
 */
describe("TSCallResolver.resolveDispatch — type-alias object contract receiver (bd tea-rags-mcp-6ea2k)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-alias-contract-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function writeAliasFixture(implementsClause: string): void {
    writeSource(repoRoot, "src/port.ts", [
      `export type StorePort = {`,
      `  read<T>(key: string): T | null;`,
      `  write<T>(key: string, value: T): void;`,
      `};`,
    ]);
    writeSource(repoRoot, "src/local.ts", [
      `import type { StorePort } from "./port.js";`,
      ``,
      `export class LocalStore${implementsClause} {`,
      `  read<T>(key: string): T | null {`,
      `    return key.length > 0 ? null : null;`,
      `  }`,
      ``,
      `  write<T>(key: string, value: T): void {`,
      `    void key;`,
      `    void value;`,
      `  }`,
      `}`,
    ]);
    writeSource(repoRoot, "src/other.ts", [
      `export class Ledger {`,
      `  write(a: number, b: number, c: number): void {`,
      `    void (a + b + c);`,
      `  }`,
      `}`,
    ]);
    writeSource(repoRoot, "src/engine.ts", [
      `import type { StorePort } from "./port.js";`,
      ``,
      `export class Engine {`,
      `  private readonly local: StorePort;`,
      ``,
      `  constructor(local: StorePort) {`,
      `    this.local = local;`,
      `  }`,
      ``,
      `  pull<T>(key: string): T | null {`,
      `    return this.local.read<T>(key);`,
      `  }`,
      ``,
      `  push(key: string): void {`,
      `    this.local.write(key, 1);`,
      `  }`,
      `}`,
    ]);
  }

  const arity = (minRequired: number, maxPositional: number) => ({ minRequired, maxPositional, hasSplat: false });
  const tableOf = (): InMemoryGlobalSymbolTable => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("src/port.ts", []);
    table.upsertFile("src/local.ts", [
      sym("LocalStore", "LocalStore", "src/local.ts", []),
      { ...sym("LocalStore#read", "read", "src/local.ts", ["LocalStore"]), arity: arity(1, 1) },
      { ...sym("LocalStore#write", "write", "src/local.ts", ["LocalStore"]), arity: arity(2, 2) },
    ]);
    table.upsertFile("src/other.ts", [
      sym("Ledger", "Ledger", "src/other.ts", []),
      { ...sym("Ledger#write", "write", "src/other.ts", ["Ledger"]), arity: arity(3, 3) },
    ]);
    table.upsertFile("src/engine.ts", [
      sym("Engine", "Engine", "src/engine.ts", []),
      sym("Engine#pull", "pull", "src/engine.ts", ["Engine"]),
      sym("Engine#push", "push", "src/engine.ts", ["Engine"]),
    ]);
    return table;
  };
  const engineCtx = (table: InMemoryGlobalSymbolTable, hierarchy: MapHierarchyView): CallContext => ({
    callerFile: "src/engine.ts",
    callerScope: ["Engine"],
    imports: [],
    classFieldTypes: { Engine: { local: "StorePort" } },
    symbolTable: table,
    hierarchy,
  });
  const READ_CALL: CallRef = {
    callText: "this.local.read<T>(key)",
    receiver: "this.local",
    member: "read",
    startLine: 11,
  };
  const WRITE_CALL: CallRef = {
    callText: "this.local.write(key, 1)",
    receiver: "this.local",
    member: "write",
    startLine: 15,
  };
  const resolver = (): TSCallResolver => new TSCallResolver(tsOptions, DEFAULT_AMBIGUOUS_RESOLVE_MODE, repoRoot);

  it("reaches the class that `implements` the alias through the nominal row", () => {
    writeAliasFixture(" implements StorePort");
    const ctx = engineCtx(tableOf(), hierarchyOf([["LocalStore", "StorePort"]]));

    expect(edgesOf(resolver().resolveDispatch(READ_CALL, ctx))).toEqual([edgeTo("src/local.ts", "LocalStore#read", 1)]);
    expect(edgesOf(resolver().resolveDispatch(WRITE_CALL, ctx))).toEqual([
      edgeTo("src/local.ts", "LocalStore#write", 1),
    ]);
  });

  it("reaches a class that conforms to the alias without `implements`", () => {
    writeAliasFixture("");
    const table = tableOf();
    const structuralRows = new TypeScriptLanguage().structuralConformance({
      contracts: [
        {
          name: "StorePort",
          members: [
            { name: "read", params: 1 },
            { name: "write", params: 2 },
          ],
        },
      ],
      memberDefinitions: [...table.lookupByShortName("read"), ...table.lookupByShortName("write")],
      nominalRows: [],
    });
    const ctx = engineCtx(table, new MapHierarchyView(buildHierarchySnapshot(structuralRows)));

    expect(structuralRows.map((row) => `${row.sourceFqName} ${row.kind} ${row.ancestorFqName}`)).toEqual([
      "LocalStore structural StorePort",
    ]);
    expect(edgesOf(resolver().resolveDispatch(WRITE_CALL, ctx))).toEqual([
      edgeTo("src/local.ts", "LocalStore#write", 1),
    ]);
  });
});
