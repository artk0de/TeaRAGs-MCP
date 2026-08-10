import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CallContext, CallRef } from "../../../../../../src/core/contracts/types/codegraph.js";
import {
  classifyTypeCheckerFallbackCase,
  TSTypeCheckerFallbackSymbolResolutionStrategy,
} from "../../../../../../src/core/domains/language/typescript/resolver/strategies/ts-type-checker-fallback.js";
import { TSProgramCache } from "../../../../../../src/core/domains/language/typescript/resolver/ts-program-cache.js";
import { TSCallResolver } from "../../../../../../src/core/domains/language/typescript/resolver/ts-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function writeSource(repoRoot: string, relPath: string, content: string): void {
  const abs = join(repoRoot, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

/** Two same-named methods on two classes — the ambiguity strict mode drops. */
function ambiguousFetchTable(): InMemoryGlobalSymbolTable {
  const symbolTable = new InMemoryGlobalSymbolTable();
  symbolTable.upsertFile("src/user-repo.ts", [
    {
      symbolId: "UserRepo#fetch",
      fqName: "UserRepo#fetch",
      shortName: "fetch",
      relPath: "src/user-repo.ts",
      scope: ["UserRepo"],
    },
  ]);
  symbolTable.upsertFile("src/order-repo.ts", [
    {
      symbolId: "OrderRepo#fetch",
      fqName: "OrderRepo#fetch",
      shortName: "fetch",
      relPath: "src/order-repo.ts",
      scope: ["OrderRepo"],
    },
  ]);
  return symbolTable;
}

/**
 * `repo` is bound to the result of a generic factory call, so no tree-sitter
 * pass can type it; `fetch` is declared on two classes, so strict mode drops the
 * short-name lookup. Only the type checker knows the receiver is a `UserRepo`.
 */
function writeInferredReceiverFixture(repoRoot: string): void {
  writeSource(
    repoRoot,
    "src/user-repo.ts",
    `export class UserRepo {\n  fetch(id: string): string {\n    return id;\n  }\n}\n`,
  );
  writeSource(
    repoRoot,
    "src/order-repo.ts",
    `export class OrderRepo {\n  fetch(id: string): string {\n    return id;\n  }\n}\n`,
  );
  writeSource(
    repoRoot,
    "src/caller.ts",
    [
      `import { UserRepo } from "./user-repo.js";`,
      `import { OrderRepo } from "./order-repo.js";`,
      ``,
      `function make<T>(factory: () => T): T {`,
      `  return factory();`,
      `}`,
      ``,
      `export function run(): string {`,
      `  const repo = make(() => new UserRepo());`,
      `  return repo.fetch("42");`,
      `}`,
      ``,
      `export function keep(other: OrderRepo): OrderRepo {`,
      `  return other;`,
      `}`,
      ``,
    ].join("\n"),
  );
}

const INFERRED_RECEIVER_CALL: CallRef = {
  callText: 'repo.fetch("42")',
  receiver: "repo",
  member: "fetch",
  startLine: 10,
};

function inferredReceiverContext(symbolTable: InMemoryGlobalSymbolTable): CallContext {
  return {
    callerFile: "src/caller.ts",
    callerScope: [],
    imports: [
      { importText: "./user-repo.js", startLine: 1, importedNames: ["UserRepo"] },
      { importText: "./order-repo.js", startLine: 2, importedNames: ["OrderRepo"] },
    ],
    symbolTable,
  };
}

describe("TSTypeCheckerFallbackSymbolResolutionStrategy routes only checker-worthy call shapes (bd tea-rags-mcp-uclbn)", () => {
  it("classifies a call carrying explicit type arguments as generic", () => {
    const symbolTable = new InMemoryGlobalSymbolTable();
    const call: CallRef = { callText: "decode<Config>(raw)", receiver: null, member: "decode", startLine: 1 };

    expect(
      classifyTypeCheckerFallbackCase(call, { callerFile: "src/a.ts", callerScope: [], imports: [], symbolTable }),
    ).toBe("generic");
  });

  it("classifies a member declared on more than one type as overload", () => {
    const call: CallRef = { callText: 'repo.fetch("42")', receiver: "repo", member: "fetch", startLine: 1 };

    expect(classifyTypeCheckerFallbackCase(call, inferredReceiverContext(ambiguousFetchTable()))).toBe("overload");
  });

  it("declines an unambiguous non-generic call as not worth the checker cost", () => {
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("src/a.ts", [
      { symbolId: "A#run", fqName: "A#run", shortName: "run", relPath: "src/a.ts", scope: ["A"] },
    ]);
    const call: CallRef = { callText: "x.run()", receiver: "x", member: "run", startLine: 1 };

    expect(
      classifyTypeCheckerFallbackCase(call, { callerFile: "src/b.ts", callerScope: [], imports: [], symbolTable }),
    ).toBeNull();
  });

  it("prefers the generic classification when a generic call is also ambiguous", () => {
    const call: CallRef = { callText: "repo.fetch<string>(id)", receiver: "repo", member: "fetch", startLine: 1 };

    expect(classifyTypeCheckerFallbackCase(call, inferredReceiverContext(ambiguousFetchTable()))).toBe("generic");
  });

  it("does not mistake a less-than comparison for explicit type arguments", () => {
    const symbolTable = new InMemoryGlobalSymbolTable();
    const call: CallRef = { callText: "count < limit && run(x)", receiver: null, member: "run", startLine: 1 };

    expect(
      classifyTypeCheckerFallbackCase(call, { callerFile: "src/a.ts", callerScope: [], imports: [], symbolTable }),
    ).toBeNull();
  });
});

describe("TSTypeCheckerFallbackSymbolResolutionStrategy resolves the signature the checker picks (bd tea-rags-mcp-uclbn)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-typechecker-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function buildStrategy(): TSTypeCheckerFallbackSymbolResolutionStrategy {
    const tsOptions = { baseUrl: ".", paths: {} };
    return new TSTypeCheckerFallbackSymbolResolutionStrategy(
      { tsOptions, mode: "strict" },
      new TSProgramCache({ repoRoot, tsOptions }),
    );
  }

  it("pins an ambiguous member to the class the checker inferred for the receiver", () => {
    writeInferredReceiverFixture(repoRoot);

    const outcome = buildStrategy().attempt(INFERRED_RECEIVER_CALL, inferredReceiverContext(ambiguousFetchTable()));

    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/user-repo.ts", targetSymbolId: "UserRepo#fetch" },
    });
  });

  it("resolves a static method call to its dotted symbolId", () => {
    writeSource(
      repoRoot,
      "src/registry.ts",
      `export class Registry {\n  static make<T>(key: string): T {\n    return key as unknown as T;\n  }\n}\n`,
    );
    writeSource(
      repoRoot,
      "src/caller.ts",
      [
        `import { Registry } from "./registry.js";`,
        ``,
        `export function run(): string {`,
        `  return Registry.make<string>("a");`,
        `}`,
        ``,
      ].join("\n"),
    );
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("src/registry.ts", [
      {
        symbolId: "Registry.make",
        fqName: "Registry.make",
        shortName: "make",
        relPath: "src/registry.ts",
        scope: ["Registry"],
      },
    ]);

    const outcome = buildStrategy().attempt(
      { callText: 'Registry.make<string>("a")', receiver: "Registry", member: "make", startLine: 4 },
      {
        callerFile: "src/caller.ts",
        callerScope: [],
        imports: [{ importText: "./registry.js", startLine: 1, importedNames: ["Registry"] }],
        symbolTable,
      },
    );

    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/registry.ts", targetSymbolId: "Registry.make" },
    });
  });

  it("emits a file-only target when the declaring file carries no matching symbol", () => {
    writeSource(repoRoot, "src/util.ts", `export function pick<T>(items: T[]): T {\n  return items[0];\n}\n`);
    writeSource(
      repoRoot,
      "src/caller.ts",
      [
        `import { pick } from "./util.js";`,
        ``,
        `export function run(items: string[]): string {`,
        `  return pick<string>(items);`,
        `}`,
        ``,
      ].join("\n"),
    );

    const outcome = buildStrategy().attempt(
      { callText: "pick<string>(items)", receiver: null, member: "pick", startLine: 4 },
      {
        callerFile: "src/caller.ts",
        callerScope: [],
        imports: [{ importText: "./util.js", startLine: 1, importedNames: ["pick"] }],
        symbolTable: new InMemoryGlobalSymbolTable(),
      },
    );

    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/util.ts", targetSymbolId: null },
    });
  });

  it("falls back to the declaration's short name when that file composes the id differently", () => {
    writeInferredReceiverFixture(repoRoot);
    // The chunker recorded `fetch` under the STATIC form. The checker still
    // names the right file and the right member, so narrowing the short name to
    // that one file recovers the target instead of dropping to a file-only edge.
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("src/user-repo.ts", [
      {
        symbolId: "UserRepo.fetch",
        fqName: "UserRepo.fetch",
        shortName: "fetch",
        relPath: "src/user-repo.ts",
        scope: ["UserRepo"],
      },
    ]);
    symbolTable.upsertFile("src/order-repo.ts", [
      {
        symbolId: "OrderRepo#fetch",
        fqName: "OrderRepo#fetch",
        shortName: "fetch",
        relPath: "src/order-repo.ts",
        scope: ["OrderRepo"],
      },
    ]);

    const outcome = buildStrategy().attempt(INFERRED_RECEIVER_CALL, inferredReceiverContext(symbolTable));

    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/user-repo.ts", targetSymbolId: "UserRepo.fetch" },
    });
  });

  it("names an arrow function by the const it is assigned to", () => {
    writeSource(repoRoot, "src/util.ts", `export const identity = <T>(value: T): T => value;\n`);
    writeSource(
      repoRoot,
      "src/caller.ts",
      [
        `import { identity } from "./util.js";`,
        ``,
        `const handlers: Array<(v: string) => string> = [];`,
        ``,
        `export function run(): string {`,
        `  handlers[0]("skip");`,
        `  return identity<string>("a");`,
        `}`,
        ``,
      ].join("\n"),
    );
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("src/util.ts", [
      { symbolId: "identity", fqName: "identity", shortName: "identity", relPath: "src/util.ts", scope: [] },
    ]);

    const outcome = buildStrategy().attempt(
      { callText: 'identity<string>("a")', receiver: null, member: "identity", startLine: 7 },
      {
        callerFile: "src/caller.ts",
        callerScope: [],
        imports: [{ importText: "./util.js", startLine: 1, importedNames: ["identity"] }],
        symbolTable,
      },
    );

    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/util.ts", targetSymbolId: "identity" },
    });
  });

  it("continues when the checker resolves the call into a declaration outside the project", () => {
    writeSource(repoRoot, "src/caller.ts", `export function run(value: string): string {\n  return value.trim();\n}\n`);
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("src/a.ts", [
      { symbolId: "A#trim", fqName: "A#trim", shortName: "trim", relPath: "src/a.ts", scope: ["A"] },
    ]);
    symbolTable.upsertFile("src/b.ts", [
      { symbolId: "B#trim", fqName: "B#trim", shortName: "trim", relPath: "src/b.ts", scope: ["B"] },
    ]);

    const outcome = buildStrategy().attempt(
      { callText: "value.trim()", receiver: "value", member: "trim", startLine: 2 },
      { callerFile: "src/caller.ts", callerScope: [], imports: [], symbolTable },
    );

    expect(outcome).toEqual({ kind: "continue" });
  });

  it("continues when no Program can be built for the caller file", () => {
    const outcome = buildStrategy().attempt(INFERRED_RECEIVER_CALL, inferredReceiverContext(ambiguousFetchTable()));

    expect(outcome).toEqual({ kind: "continue" });
  });

  it("continues when no call expression sits at the recorded line", () => {
    writeInferredReceiverFixture(repoRoot);

    const outcome = buildStrategy().attempt(
      { ...INFERRED_RECEIVER_CALL, startLine: 3 },
      inferredReceiverContext(ambiguousFetchTable()),
    );

    expect(outcome).toEqual({ kind: "continue" });
  });

  it("continues on a call shape no checker case covers, without building a Program", () => {
    writeInferredReceiverFixture(repoRoot);
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("src/user-repo.ts", [
      {
        symbolId: "UserRepo#fetch",
        fqName: "UserRepo#fetch",
        shortName: "fetch",
        relPath: "src/user-repo.ts",
        scope: ["UserRepo"],
      },
    ]);
    const tsOptions = { baseUrl: ".", paths: {} };
    const cache = new TSProgramCache({ repoRoot, tsOptions });
    const strategy = new TSTypeCheckerFallbackSymbolResolutionStrategy({ tsOptions, mode: "strict" }, cache);

    const outcome = strategy.attempt(INFERRED_RECEIVER_CALL, inferredReceiverContext(symbolTable));

    expect(outcome).toEqual({ kind: "continue" });
    expect(cache.size).toBe(0);
  });
});

describe("TSCallResolver runs the type-checker fallback after every tree-sitter pass (bd tea-rags-mcp-uclbn)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-typechecker-chain-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
    delete process.env.CODEGRAPH_TS_TYPECHECKER;
  });

  it("resolves an ambiguous receiver the tree-sitter chain drops", () => {
    writeInferredReceiverFixture(repoRoot);
    const resolver = new TSCallResolver({ baseUrl: ".", paths: {} }, "strict", repoRoot);

    const target = resolver.resolve(INFERRED_RECEIVER_CALL, inferredReceiverContext(ambiguousFetchTable()));

    expect(target).toEqual({ targetRelPath: "src/user-repo.ts", targetSymbolId: "UserRepo#fetch" });
  });

  it("leaves the same call unresolved when CODEGRAPH_TS_TYPECHECKER disables the fallback", () => {
    writeInferredReceiverFixture(repoRoot);
    process.env.CODEGRAPH_TS_TYPECHECKER = "0";
    const resolver = new TSCallResolver({ baseUrl: ".", paths: {} }, "strict", repoRoot);

    const target = resolver.resolve(INFERRED_RECEIVER_CALL, inferredReceiverContext(ambiguousFetchTable()));

    expect(target).toBeNull();
  });

  it("keeps an earlier pass decisive — this.X() still resolves intra-class", () => {
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("src/store.ts", [
      { symbolId: "Store.read", fqName: "Store.read", shortName: "read", relPath: "src/store.ts", scope: ["Store"] },
    ]);
    const resolver = new TSCallResolver({ baseUrl: ".", paths: {} }, "strict", repoRoot);

    const target = resolver.resolve(
      { callText: "this.read()", receiver: "this", member: "read", startLine: 7 },
      { callerFile: "src/store.ts", callerScope: ["Store"], imports: [], symbolTable },
    );

    expect(target).toEqual({ targetRelPath: "src/store.ts", targetSymbolId: "Store.read" });
  });
});
