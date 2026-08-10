import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CallContext, CallRef } from "../../../../../../src/core/contracts/types/codegraph.js";
import {
  classifyStructuralTypingCase,
  TSStructuralTypingSymbolResolutionStrategy,
} from "../../../../../../src/core/domains/language/typescript/resolver/strategies/ts-type-checker-structural-typing.js";
import { TSProgramCache } from "../../../../../../src/core/domains/language/typescript/resolver/ts-program-cache.js";
import { TSCallResolver } from "../../../../../../src/core/domains/language/typescript/resolver/ts-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const TS_OPTIONS = { baseUrl: ".", paths: {} };

function writeSource(repoRoot: string, relPath: string, content: string): void {
  const abs = join(repoRoot, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

/**
 * A duck-typed namespace object: `onSave` has a real body, but it hangs off an
 * object literal, so no class or interface NAME exists for the tree-sitter
 * passes to key on. `drop` calls a member the type does not carry at all.
 */
function writeObjectLiteralFixture(repoRoot: string): void {
  writeSource(
    repoRoot,
    "src/handlers.ts",
    [`export const handlers = {`, `  onSave(id: string): string {`, `    return id;`, `  },`, `};`, ``].join("\n"),
  );
  writeSource(
    repoRoot,
    "src/caller.ts",
    [
      `import { handlers } from "./handlers.js";`,
      ``,
      `export function run(): string {`,
      `  return handlers.onSave("42");`,
      `}`,
      ``,
      `export function drop(): void {`,
      `  handlers.onDelete("1");`,
      `}`,
      ``,
    ].join("\n"),
  );
}

const OBJECT_LITERAL_CALL: CallRef = {
  callText: 'handlers.onSave("42")',
  receiver: "handlers",
  member: "onSave",
  startLine: 4,
};

function objectLiteralContext(symbolTable: InMemoryGlobalSymbolTable): CallContext {
  return {
    callerFile: "src/caller.ts",
    callerScope: [],
    imports: [{ importText: "./handlers.js", startLine: 1, importedNames: ["handlers"] }],
    symbolTable,
  };
}

function objectLiteralTable(): InMemoryGlobalSymbolTable {
  const symbolTable = new InMemoryGlobalSymbolTable();
  symbolTable.upsertFile("src/handlers.ts", [
    {
      symbolId: "handlers.onSave",
      fqName: "handlers.onSave",
      shortName: "onSave",
      relPath: "src/handlers.ts",
      scope: ["handlers"],
    },
  ]);
  return symbolTable;
}

/**
 * The literal shape the bead names: a receiver whose only type is an INLINE
 * type literal. Nothing in the project is named after it, so the member's one
 * declaration site is the annotation itself.
 */
function writeInlineTypeLiteralFixture(repoRoot: string): void {
  writeSource(
    repoRoot,
    "src/registry.ts",
    [`export const registry: { load(key: string): string } = {`, `  load: (key) => key,`, `};`, ``].join("\n"),
  );
  writeSource(
    repoRoot,
    "src/caller.ts",
    [
      `import { registry } from "./registry.js";`,
      ``,
      `export function run(): string {`,
      `  return registry.load("a");`,
      `}`,
      ``,
    ].join("\n"),
  );
}

/**
 * A structurally-typed FIELD: the walker records no `classFieldTypes` entry for
 * `out` because the initializer names no type, and `this.out` is not an import
 * binding either — so every tree-sitter pass declines and the call reaches the
 * tail of the chain.
 */
function writeStructuralFieldFixture(repoRoot: string): void {
  writeSource(
    repoRoot,
    "src/sink.ts",
    [`export const sink = {`, `  emit(line: string): string {`, `    return line;`, `  },`, `};`, ``].join("\n"),
  );
  writeSource(
    repoRoot,
    "src/service.ts",
    [
      `import { sink } from "./sink.js";`,
      ``,
      `export class Service {`,
      `  private readonly out = sink;`,
      ``,
      `  run(): string {`,
      `    return this.out.emit("x");`,
      `  }`,
      `}`,
      ``,
    ].join("\n"),
  );
}

const STRUCTURAL_FIELD_CALL: CallRef = {
  callText: 'this.out.emit("x")',
  receiver: "this.out",
  member: "emit",
  startLine: 7,
};

function structuralFieldContext(symbolTable: InMemoryGlobalSymbolTable): CallContext {
  return {
    callerFile: "src/service.ts",
    callerScope: ["Service"],
    imports: [{ importText: "./sink.js", startLine: 1, importedNames: ["sink"] }],
    symbolTable,
  };
}

/**
 * `interface Plugin` declared twice — once in the origin module, once in an
 * augmenting one. `teardown` exists ONLY on the second declaration, so a pass
 * that took the first `interface Plugin` it found would name the wrong file.
 * The receiver is a typed PARAMETER, the shape this fixture exercises. A
 * named-import receiver now reaches this pass too — `namedImport` DEFERS its
 * file-only fallback instead of committing it (bd tea-rags-mcp-5onmn), so the
 * chain runs on and a pin here outranks the parked module edge.
 */
function writeMergedInterfaceFixture(repoRoot: string): void {
  writeSource(repoRoot, "src/plugin-api.ts", [`export interface Plugin {`, `  init(): void;`, `}`, ``].join("\n"));
  writeSource(
    repoRoot,
    "src/plugin-ext.ts",
    [
      `import "./plugin-api.js";`,
      ``,
      `declare module "./plugin-api.js" {`,
      `  interface Plugin {`,
      `    teardown(): void;`,
      `  }`,
      `}`,
      ``,
    ].join("\n"),
  );
  writeSource(
    repoRoot,
    "src/caller.ts",
    [
      `import type { Plugin } from "./plugin-api.js";`,
      `import "./plugin-ext.js";`,
      ``,
      `export function run(plugin: Plugin): void {`,
      `  plugin.teardown();`,
      `}`,
      ``,
    ].join("\n"),
  );
}

const MERGED_INTERFACE_CALL: CallRef = {
  callText: "plugin.teardown()",
  receiver: "plugin",
  member: "teardown",
  startLine: 5,
};

function mergedInterfaceContext(symbolTable: InMemoryGlobalSymbolTable): CallContext {
  return {
    callerFile: "src/caller.ts",
    callerScope: [],
    imports: [
      { importText: "./plugin-api.js", startLine: 1, importedNames: ["Plugin"] },
      { importText: "./plugin-ext.js", startLine: 2, importedNames: [] },
    ],
    symbolTable,
    localBindings: { plugin: [{ line: 4, type: "Plugin" }] },
  };
}

/**
 * The genuinely ambiguous merge: BOTH declarations of `Api` declare `send`, so
 * the merged type carries two declaration sites in two different files.
 */
function writeConflictingMergeFixture(repoRoot: string): void {
  writeSource(
    repoRoot,
    "src/api-core.ts",
    [`export interface Api {`, `  send(value: string): void;`, `}`, ``].join("\n"),
  );
  writeSource(
    repoRoot,
    "src/api-ext.ts",
    [
      `import "./api-core.js";`,
      ``,
      `declare module "./api-core.js" {`,
      `  interface Api {`,
      `    send(value: number): void;`,
      `  }`,
      `}`,
      ``,
    ].join("\n"),
  );
  writeSource(
    repoRoot,
    "src/caller.ts",
    [
      `import type { Api } from "./api-core.js";`,
      `import "./api-ext.js";`,
      ``,
      `export function run(api: Api): void {`,
      `  api.send("a");`,
      `}`,
      ``,
    ].join("\n"),
  );
}

const CONFLICTING_MERGE_CALL: CallRef = {
  callText: 'api.send("a")',
  receiver: "api",
  member: "send",
  startLine: 5,
};

function conflictingMergeContext(symbolTable: InMemoryGlobalSymbolTable): CallContext {
  return {
    callerFile: "src/caller.ts",
    callerScope: [],
    imports: [
      { importText: "./api-core.js", startLine: 1, importedNames: ["Api"] },
      { importText: "./api-ext.js", startLine: 2, importedNames: [] },
    ],
    symbolTable,
    localBindings: { api: [{ line: 4, type: "Api" }] },
  };
}

describe("classifyStructuralTypingCase routes only receivers worth a type query (bd tea-rags-mcp-icmnr)", () => {
  const symbolTable = new InMemoryGlobalSymbolTable();

  it("classifies a receiver with no tree-sitter-bound type as structural", () => {
    expect(classifyStructuralTypingCase(OBJECT_LITERAL_CALL, objectLiteralContext(symbolTable), TS_OPTIONS)).toBe(
      "structural",
    );
  });

  it("classifies a receiver carrying a bound nominal type as merged", () => {
    expect(classifyStructuralTypingCase(MERGED_INTERFACE_CALL, mergedInterfaceContext(symbolTable), TS_OPTIONS)).toBe(
      "merged",
    );
  });

  it("classifies a this-field receiver whose field has a declared type as merged", () => {
    const call: CallRef = { callText: "this.out.emit()", receiver: "this.out", member: "emit", startLine: 7 };

    expect(
      classifyStructuralTypingCase(
        call,
        {
          callerFile: "src/service.ts",
          callerScope: ["Service"],
          imports: [],
          symbolTable,
          classFieldTypes: { Service: { out: "Sink" } },
        },
        TS_OPTIONS,
      ),
    ).toBe("merged");
  });

  it("classifies a this-field receiver the walker recorded no type for as structural", () => {
    expect(classifyStructuralTypingCase(STRUCTURAL_FIELD_CALL, structuralFieldContext(symbolTable), TS_OPTIONS)).toBe(
      "structural",
    );
  });

  it("declines a call with no receiver, which carries no type to interrogate", () => {
    const call: CallRef = { callText: "run(x)", receiver: null, member: "run", startLine: 1 };

    expect(
      classifyStructuralTypingCase(
        call,
        { callerFile: "src/a.ts", callerScope: [], imports: [], symbolTable },
        TS_OPTIONS,
      ),
    ).toBeNull();
  });

  it("declines an ambient ECMAScript namespace receiver", () => {
    const call: CallRef = { callText: "Math.max(a, b)", receiver: "Math", member: "max", startLine: 1 };

    expect(
      classifyStructuralTypingCase(
        call,
        { callerFile: "src/a.ts", callerScope: [], imports: [], symbolTable },
        TS_OPTIONS,
      ),
    ).toBeNull();
  });

  it("declines a receiver bound to an import that leaves the project", () => {
    const call: CallRef = { callText: "axios.get(url)", receiver: "axios", member: "get", startLine: 3 };

    expect(
      classifyStructuralTypingCase(
        call,
        {
          callerFile: "src/a.ts",
          callerScope: [],
          imports: [{ importText: "axios", startLine: 1, importedNames: ["axios"] }],
          symbolTable,
        },
        TS_OPTIONS,
      ),
    ).toBeNull();
  });

  it("declines a receiver whose bound type is an ECMAScript builtin instance", () => {
    const call: CallRef = { callText: "cache.get(key)", receiver: "cache", member: "get", startLine: 4 };

    expect(
      classifyStructuralTypingCase(
        call,
        {
          callerFile: "src/a.ts",
          callerScope: [],
          imports: [],
          symbolTable,
          localBindings: { cache: [{ line: 3, type: "Map" }] },
        },
        TS_OPTIONS,
      ),
    ).toBeNull();
  });
});

describe("TSStructuralTypingSymbolResolutionStrategy resolves duck-typed receivers through the checker (bd tea-rags-mcp-icmnr)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-structural-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function buildStrategy(): TSStructuralTypingSymbolResolutionStrategy {
    return new TSStructuralTypingSymbolResolutionStrategy(
      { tsOptions: TS_OPTIONS, mode: "strict" },
      new TSProgramCache({ repoRoot, tsOptions: TS_OPTIONS }),
    );
  }

  it("pins a method declared on an object literal in another file", () => {
    writeObjectLiteralFixture(repoRoot);

    const outcome = buildStrategy().attempt(OBJECT_LITERAL_CALL, objectLiteralContext(objectLiteralTable()));

    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/handlers.ts", targetSymbolId: "handlers.onSave" },
    });
  });

  it("emits a file-only target for a member declared by an inline type literal", () => {
    writeInlineTypeLiteralFixture(repoRoot);

    const outcome = buildStrategy().attempt(
      { callText: 'registry.load("a")', receiver: "registry", member: "load", startLine: 4 },
      {
        callerFile: "src/caller.ts",
        callerScope: [],
        imports: [{ importText: "./registry.js", startLine: 1, importedNames: ["registry"] }],
        symbolTable: new InMemoryGlobalSymbolTable(),
      },
    );

    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/registry.ts", targetSymbolId: null },
    });
  });

  it("leaves a receiver typed by a single-declaration interface to the cone dispatcher", () => {
    writeSource(repoRoot, "src/store.ts", [`export interface Store {`, `  read(): string;`, `}`, ``].join("\n"));
    writeSource(
      repoRoot,
      "src/caller.ts",
      [
        `import type { Store } from "./store.js";`,
        ``,
        `export function run(store: Store): string {`,
        `  return store.read();`,
        `}`,
        ``,
      ].join("\n"),
    );

    const outcome = buildStrategy().attempt(
      { callText: "store.read()", receiver: "store", member: "read", startLine: 4 },
      {
        callerFile: "src/caller.ts",
        callerScope: [],
        imports: [{ importText: "./store.js", startLine: 1, importedNames: ["Store"] }],
        symbolTable: new InMemoryGlobalSymbolTable(),
        localBindings: { store: [{ line: 3, type: "Store" }] },
      },
    );

    expect(outcome).toEqual({ kind: "continue" });
  });

  it("types a this-field receiver the walker recorded no nominal type for", () => {
    writeStructuralFieldFixture(repoRoot);
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("src/sink.ts", [
      { symbolId: "sink.emit", fqName: "sink.emit", shortName: "emit", relPath: "src/sink.ts", scope: ["sink"] },
    ]);

    const outcome = buildStrategy().attempt(STRUCTURAL_FIELD_CALL, structuralFieldContext(symbolTable));

    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/sink.ts", targetSymbolId: "sink.emit" },
    });
  });

  it("picks the merged interface declaration that actually declares the member", () => {
    writeMergedInterfaceFixture(repoRoot);
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("src/plugin-api.ts", [
      {
        symbolId: "Plugin#init",
        fqName: "Plugin#init",
        shortName: "init",
        relPath: "src/plugin-api.ts",
        scope: ["Plugin"],
      },
    ]);
    symbolTable.upsertFile("src/plugin-ext.ts", [
      {
        symbolId: "Plugin#teardown",
        fqName: "Plugin#teardown",
        shortName: "teardown",
        relPath: "src/plugin-ext.ts",
        scope: ["Plugin"],
      },
    ]);

    const outcome = buildStrategy().attempt(MERGED_INTERFACE_CALL, mergedInterfaceContext(symbolTable));

    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/plugin-ext.ts", targetSymbolId: "Plugin#teardown" },
    });
  });

  it("names the augmenting file even when no merge site is an indexed symbol", () => {
    writeMergedInterfaceFixture(repoRoot);

    const outcome = buildStrategy().attempt(
      MERGED_INTERFACE_CALL,
      mergedInterfaceContext(new InMemoryGlobalSymbolTable()),
    );

    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/plugin-ext.ts", targetSymbolId: null },
    });
  });

  it("breaks a merge that declares the member twice by the one declaration the symbol table confirms", () => {
    writeConflictingMergeFixture(repoRoot);
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("src/api-ext.ts", [
      { symbolId: "Api#send", fqName: "Api#send", shortName: "send", relPath: "src/api-ext.ts", scope: ["Api"] },
    ]);

    const outcome = buildStrategy().attempt(CONFLICTING_MERGE_CALL, conflictingMergeContext(symbolTable));

    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/api-ext.ts", targetSymbolId: "Api#send" },
    });
  });

  it("defers a merge that declares the member twice when the symbol table confirms neither", () => {
    writeConflictingMergeFixture(repoRoot);

    const outcome = buildStrategy().attempt(
      CONFLICTING_MERGE_CALL,
      conflictingMergeContext(new InMemoryGlobalSymbolTable()),
    );

    expect(outcome).toEqual({ kind: "continue" });
  });

  it("defers a merge that declares the member twice when the symbol table confirms both", () => {
    writeConflictingMergeFixture(repoRoot);
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("src/api-core.ts", [
      { symbolId: "Api#send", fqName: "Api#send", shortName: "send", relPath: "src/api-core.ts", scope: ["Api"] },
    ]);
    symbolTable.upsertFile("src/api-ext.ts", [
      { symbolId: "Api#send", fqName: "Api#send", shortName: "send", relPath: "src/api-ext.ts", scope: ["Api"] },
    ]);

    const outcome = buildStrategy().attempt(CONFLICTING_MERGE_CALL, conflictingMergeContext(symbolTable));

    expect(outcome).toEqual({ kind: "continue" });
  });

  it("continues when the member resolves into a declaration outside the project", () => {
    writeSource(repoRoot, "src/caller.ts", `export function run(value: string): string {\n  return value.trim();\n}\n`);

    const outcome = buildStrategy().attempt(
      { callText: "value.trim()", receiver: "value", member: "trim", startLine: 2 },
      { callerFile: "src/caller.ts", callerScope: [], imports: [], symbolTable: new InMemoryGlobalSymbolTable() },
    );

    expect(outcome).toEqual({ kind: "continue" });
  });

  it("continues when the receiver's type carries no such member at all", () => {
    writeObjectLiteralFixture(repoRoot);

    const outcome = buildStrategy().attempt(
      { callText: 'handlers.onDelete("1")', receiver: "handlers", member: "onDelete", startLine: 8 },
      objectLiteralContext(objectLiteralTable()),
    );

    expect(outcome).toEqual({ kind: "continue" });
  });

  it("continues when no Program can be built for the caller file", () => {
    const outcome = buildStrategy().attempt(OBJECT_LITERAL_CALL, objectLiteralContext(objectLiteralTable()));

    expect(outcome).toEqual({ kind: "continue" });
  });

  it("continues when no member call sits at the recorded line", () => {
    writeObjectLiteralFixture(repoRoot);

    const outcome = buildStrategy().attempt(
      { ...OBJECT_LITERAL_CALL, startLine: 3 },
      objectLiteralContext(objectLiteralTable()),
    );

    expect(outcome).toEqual({ kind: "continue" });
  });

  it("builds no Program for a call shape the classifier declines", () => {
    writeObjectLiteralFixture(repoRoot);
    const cache = new TSProgramCache({ repoRoot, tsOptions: TS_OPTIONS });
    const strategy = new TSStructuralTypingSymbolResolutionStrategy({ tsOptions: TS_OPTIONS, mode: "strict" }, cache);

    const outcome = strategy.attempt(
      { callText: "Math.max(a, b)", receiver: "Math", member: "max", startLine: 4 },
      objectLiteralContext(objectLiteralTable()),
    );

    expect(outcome).toEqual({ kind: "continue" });
    expect(cache.size).toBe(0);
  });
});

/**
 * The precision invariant `tea-rags-mcp-7mud8` was filed to ADD, pinned instead
 * because the pass already holds it.
 *
 * The bead's hypothesis was that this pass matches a member on a structurally
 * typed receiver and then confirms it against an unrelated project symbol of the
 * same short name — the failure mode `tea-rags-mcp-6b3gj` fixed for the
 * short-name passes, restated for interface-shaped externals. It cannot happen
 * here, and the reason is structural rather than lucky: the member's declaration
 * comes from the CHECKER, and {@link TSStructuralTypingSymbolResolutionStrategy}
 * drops every declaration `TSProgramCache.toRelPath` places outside the project
 * BEFORE any symbol-table lookup runs. Short-name narrowing only ever sees a
 * file the checker already proved is in-project.
 *
 * That ordering is worth a test because it is invisible: a later edit that moved
 * the short-name fallback up to cover the empty-sites case — the obvious way to
 * buy recall here — would fabricate exactly these edges and break nothing else.
 *
 * The oracle run behind the bead measured the two shapes below as the live
 * corpus's top phantom producers (`Map#set` matched to a project `set`), so
 * these are the real call sites, not invented ones. On this pass they resolve to
 * `continue`; the edges the oracle counted came from passes 5/6/9/10.
 */
describe("TSStructuralTypingSymbolResolutionStrategy never pins an external member to a same-named project symbol (bd tea-rags-mcp-7mud8)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-structural-external-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function buildStrategy(): TSStructuralTypingSymbolResolutionStrategy {
    return new TSStructuralTypingSymbolResolutionStrategy(
      { tsOptions: TS_OPTIONS, mode: "strict" },
      new TSProgramCache({ repoRoot, tsOptions: TS_OPTIONS }),
    );
  }

  /**
   * `Map#set` on a receiver the walker bound NO type to, in a project whose
   * symbol table carries exactly one `set`. The builtin-type gate in
   * `classifyStructuralTypingCase` cannot fire — it reads walker bindings, and
   * there are none — so the call reaches the checker, which is the whole point:
   * the decline has to come from the declaration filter, not from the gate.
   */
  it("declines a builtin member when the symbol table holds a lone project symbol of that name", () => {
    writeSource(
      repoRoot,
      "src/memo.ts",
      [`export class CommitDiffMemo {`, `  set(key: string, value: number): void {}`, `}`, ``].join("\n"),
    );
    writeSource(
      repoRoot,
      "src/caller.ts",
      [`export function run(cache: Map<string, number>): void {`, `  cache.set("a", 1);`, `}`, ``].join("\n"),
    );
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("src/memo.ts", [
      {
        symbolId: "CommitDiffMemo#set",
        fqName: "CommitDiffMemo#set",
        shortName: "set",
        relPath: "src/memo.ts",
        scope: ["CommitDiffMemo"],
      },
    ]);

    const outcome = buildStrategy().attempt(
      { callText: 'cache.set("a", 1)', receiver: "cache", member: "set", startLine: 2 },
      { callerFile: "src/caller.ts", callerScope: [], imports: [], symbolTable },
    );

    expect(outcome).toEqual({ kind: "continue" });
  });

  /**
   * The bead's literal shape: a receiver typed by an INTERFACE that lives
   * outside the project — a test framework's matcher, a schema library's shape.
   * The import is relative and therefore maps to a real file, so nothing in
   * `classifyStructuralTypingCase` declines it; the interface simply sits
   * outside `repoRoot`, which is what makes its member external.
   */
  it("declines a member declared only on an interface outside the project root", () => {
    const external = realpathSync(mkdtempSync(join(tmpdir(), "ts-structural-lib-")));
    try {
      writeSource(
        external,
        "matchers.ts",
        [`export interface Matchers {`, `  toBe(value: unknown): void;`, `}`, ``].join("\n"),
      );
      writeSource(
        repoRoot,
        "src/assert.ts",
        [`export class Assertions {`, `  toBe(value: unknown): void {}`, `}`, ``].join("\n"),
      );
      writeSource(
        repoRoot,
        "src/caller.ts",
        [
          `import type { Matchers } from "${join(external, "matchers.js")}";`,
          ``,
          `export function run(m: Matchers): void {`,
          `  m.toBe(1);`,
          `}`,
          ``,
        ].join("\n"),
      );
      const symbolTable = new InMemoryGlobalSymbolTable();
      symbolTable.upsertFile("src/assert.ts", [
        {
          symbolId: "Assertions#toBe",
          fqName: "Assertions#toBe",
          shortName: "toBe",
          relPath: "src/assert.ts",
          scope: ["Assertions"],
        },
      ]);

      const outcome = buildStrategy().attempt(
        { callText: "m.toBe(1)", receiver: "m", member: "toBe", startLine: 4 },
        { callerFile: "src/caller.ts", callerScope: [], imports: [], symbolTable },
      );

      expect(outcome).toEqual({ kind: "continue" });
    } finally {
      rmSync(external, { recursive: true, force: true });
    }
  });
});

describe("TSCallResolver runs the structural-typing pass for calls every other pass declines (bd tea-rags-mcp-icmnr)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-structural-chain-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
    delete process.env.CODEGRAPH_TS_TYPECHECKER;
  });

  it("resolves a structurally-typed field receiver no tree-sitter pass can name", () => {
    writeStructuralFieldFixture(repoRoot);
    const resolver = new TSCallResolver(TS_OPTIONS, "strict", repoRoot);

    const target = resolver.resolve(STRUCTURAL_FIELD_CALL, structuralFieldContext(new InMemoryGlobalSymbolTable()));

    expect(target).toEqual({ targetRelPath: "src/sink.ts", targetSymbolId: null });
  });

  it("shares one Program cache with the type-checker fallback rather than building a second", () => {
    writeStructuralFieldFixture(repoRoot);
    const resolver = new TSCallResolver(TS_OPTIONS, "strict", repoRoot);

    resolver.resolve(STRUCTURAL_FIELD_CALL, structuralFieldContext(new InMemoryGlobalSymbolTable()));

    expect(resolver.programCache?.size).toBe(1);
  });

  it("leaves the same call unresolved when CODEGRAPH_TS_TYPECHECKER disables the checker passes", () => {
    writeStructuralFieldFixture(repoRoot);
    process.env.CODEGRAPH_TS_TYPECHECKER = "0";
    const resolver = new TSCallResolver(TS_OPTIONS, "strict", repoRoot);

    const target = resolver.resolve(STRUCTURAL_FIELD_CALL, structuralFieldContext(new InMemoryGlobalSymbolTable()));

    expect(target).toBeNull();
  });
});
