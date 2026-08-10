import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CallContext, CallRef } from "../../../../../../src/core/contracts/types/codegraph.js";
import { TSTypeCheckerReturnTypeInferenceSymbolResolutionStrategy } from "../../../../../../src/core/domains/language/typescript/resolver/strategies/ts-type-checker-return-type-inference.js";
import { TSProgramCache } from "../../../../../../src/core/domains/language/typescript/resolver/ts-program-cache.js";
import { TSCallResolver } from "../../../../../../src/core/domains/language/typescript/resolver/ts-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function writeSource(repoRoot: string, relPath: string, content: string): void {
  const abs = join(repoRoot, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

/**
 * `Foo#method` and `Bar#method` — the member name is declared twice, so every
 * short-name pass ahead of the checker correctly declines under strict mode.
 * Whatever resolves this call did so on TYPE information, not on cardinality.
 */
function ambiguousMethodTable(): InMemoryGlobalSymbolTable {
  const symbolTable = new InMemoryGlobalSymbolTable();
  symbolTable.upsertFile("src/foo.ts", [
    { symbolId: "Foo#method", fqName: "Foo#method", shortName: "method", relPath: "src/foo.ts", scope: ["Foo"] },
  ]);
  symbolTable.upsertFile("src/bar.ts", [
    { symbolId: "Bar#method", fqName: "Bar#method", shortName: "method", relPath: "src/bar.ts", scope: ["Bar"] },
  ]);
  return symbolTable;
}

/** `Foo` plus the un-annotated factory whose INFERRED return type is the whole point. */
function writeFooAndBar(repoRoot: string): void {
  writeSource(
    repoRoot,
    "src/foo.ts",
    [
      `export class Foo {`,
      `  method(): string {`,
      `    return "foo";`,
      `  }`,
      `}`,
      ``,
      `export function makeFoo() {`,
      `  return new Foo();`,
      `}`,
      ``,
    ].join("\n"),
  );
  writeSource(
    repoRoot,
    "src/bar.ts",
    [`export class Bar {`, `  method(): string {`, `    return "bar";`, `  }`, `}`, ``].join("\n"),
  );
}

/**
 * The direct case: `const x = makeFoo(); x.method()`. `x` carries no annotation
 * anywhere — its type exists only as the checker's inferred return type of
 * `makeFoo`.
 */
function writeDirectFactoryFixture(repoRoot: string): void {
  writeFooAndBar(repoRoot);
  writeSource(
    repoRoot,
    "src/caller.ts",
    [
      `import { makeFoo } from "./foo.js";`,
      `import { Bar } from "./bar.js";`,
      ``,
      `export function run(): string {`,
      `  const x = makeFoo();`,
      `  return x.method();`,
      `}`,
      ``,
      `export function keep(other: Bar): string {`,
      `  return other.method();`,
      `}`,
      ``,
    ].join("\n"),
  );
}

const DIRECT_CALL: CallRef = { callText: "x.method()", receiver: "x", member: "method", startLine: 6 };

function callerContext(symbolTable: InMemoryGlobalSymbolTable, overrides: Partial<CallContext> = {}): CallContext {
  return {
    callerFile: "src/caller.ts",
    callerScope: [],
    imports: [
      { importText: "./foo.js", startLine: 1, importedNames: ["makeFoo"] },
      { importText: "./bar.js", startLine: 2, importedNames: ["Bar"] },
    ],
    symbolTable,
    ...overrides,
  };
}

describe("TSTypeCheckerReturnTypeInferenceSymbolResolutionStrategy types a receiver from a call's inferred return (bd tea-rags-mcp-l3uob)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-return-type-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function buildStrategy(
    mode: "strict" | "first" = "strict",
    cache?: TSProgramCache,
  ): TSTypeCheckerReturnTypeInferenceSymbolResolutionStrategy {
    const tsOptions = { baseUrl: ".", paths: {} };
    return new TSTypeCheckerReturnTypeInferenceSymbolResolutionStrategy(
      { tsOptions, mode },
      cache ?? new TSProgramCache({ repoRoot, tsOptions }),
    );
  }

  it("resolves a member on a receiver bound to a bare factory call", () => {
    writeDirectFactoryFixture(repoRoot);

    const outcome = buildStrategy().attempt(DIRECT_CALL, callerContext(ambiguousMethodTable()));

    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/foo.ts", targetSymbolId: "Foo#method" },
    });
  });

  it("resolves a member on a receiver bound to a METHOD call one hop further out", () => {
    writeFooAndBar(repoRoot);
    writeSource(
      repoRoot,
      "src/registry.ts",
      [
        `import { Foo } from "./foo.js";`,
        ``,
        `export class Registry {`,
        `  makeFoo() {`,
        `    return new Foo();`,
        `  }`,
        `}`,
        ``,
      ].join("\n"),
    );
    writeSource(
      repoRoot,
      "src/caller.ts",
      [
        `import { Registry } from "./registry.js";`,
        `import { Bar } from "./bar.js";`,
        ``,
        `export function run(): string {`,
        `  const registry = new Registry();`,
        `  const x = registry.makeFoo();`,
        `  return x.method();`,
        `}`,
        ``,
        `export function keep(other: Bar): string {`,
        `  return other.method();`,
        `}`,
        ``,
      ].join("\n"),
    );

    const outcome = buildStrategy().attempt(
      { callText: "x.method()", receiver: "x", member: "method", startLine: 7 },
      callerContext(ambiguousMethodTable(), {
        imports: [
          { importText: "./registry.js", startLine: 1, importedNames: ["Registry"] },
          { importText: "./bar.js", startLine: 2, importedNames: ["Bar"] },
        ],
      }),
    );

    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/foo.ts", targetSymbolId: "Foo#method" },
    });
  });

  it("unwraps an awaited factory call", () => {
    writeFooAndBar(repoRoot);
    writeSource(
      repoRoot,
      "src/loader.ts",
      [`import { Foo } from "./foo.js";`, ``, `export async function loadFoo() {`, `  return new Foo();`, `}`, ``].join(
        "\n",
      ),
    );
    writeSource(
      repoRoot,
      "src/caller.ts",
      [
        `import { loadFoo } from "./loader.js";`,
        `import { Bar } from "./bar.js";`,
        ``,
        `export async function run(): Promise<string> {`,
        `  const x = await loadFoo();`,
        `  return x.method();`,
        `}`,
        ``,
        `export function keep(other: Bar): string {`,
        `  return other.method();`,
        `}`,
        ``,
      ].join("\n"),
    );

    const outcome = buildStrategy().attempt(
      DIRECT_CALL,
      callerContext(ambiguousMethodTable(), {
        imports: [
          { importText: "./loader.js", startLine: 1, importedNames: ["loadFoo"] },
          { importText: "./bar.js", startLine: 2, importedNames: ["Bar"] },
        ],
      }),
    );

    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/foo.ts", targetSymbolId: "Foo#method" },
    });
  });

  it("composes the dotted symbolId when the inferred type is a class object", () => {
    writeSource(
      repoRoot,
      "src/widget.ts",
      [
        `export class Widget {`,
        `  static build(): string {`,
        `    return "w";`,
        `  }`,
        `}`,
        ``,
        `export function widgetClass() {`,
        `  return Widget;`,
        `}`,
        ``,
      ].join("\n"),
    );
    writeSource(
      repoRoot,
      "src/caller.ts",
      [
        `import { widgetClass } from "./widget.js";`,
        ``,
        `export function run(): string {`,
        `  const W = widgetClass();`,
        `  return W.build();`,
        `}`,
        ``,
      ].join("\n"),
    );
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("src/widget.ts", [
      {
        symbolId: "Widget.build",
        fqName: "Widget.build",
        shortName: "build",
        relPath: "src/widget.ts",
        scope: ["Widget"],
      },
    ]);

    const outcome = buildStrategy().attempt(
      { callText: "W.build()", receiver: "W", member: "build", startLine: 5 },
      callerContext(symbolTable, {
        imports: [{ importText: "./widget.js", startLine: 1, importedNames: ["widgetClass"] }],
      }),
    );

    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/widget.ts", targetSymbolId: "Widget.build" },
    });
  });

  it("follows the inheritance chain to the file the member is actually declared in", () => {
    writeSource(
      repoRoot,
      "src/base.ts",
      [`export class Base {`, `  method(): string {`, `    return "b";`, `  }`, `}`, ``].join("\n"),
    );
    writeSource(
      repoRoot,
      "src/derived.ts",
      [
        `import { Base } from "./base.js";`,
        ``,
        `export class Derived extends Base {}`,
        ``,
        `export function makeDerived() {`,
        `  return new Derived();`,
        `}`,
        ``,
      ].join("\n"),
    );
    writeSource(
      repoRoot,
      "src/caller.ts",
      [
        `import { makeDerived } from "./derived.js";`,
        ``,
        `export function run(): string {`,
        `  const x = makeDerived();`,
        `  return x.method();`,
        `}`,
        ``,
      ].join("\n"),
    );
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("src/base.ts", [
      { symbolId: "Base#method", fqName: "Base#method", shortName: "method", relPath: "src/base.ts", scope: ["Base"] },
    ]);
    symbolTable.upsertFile("src/bar.ts", [
      { symbolId: "Bar#method", fqName: "Bar#method", shortName: "method", relPath: "src/bar.ts", scope: ["Bar"] },
    ]);

    const outcome = buildStrategy().attempt(
      { callText: "x.method()", receiver: "x", member: "method", startLine: 5 },
      callerContext(symbolTable, {
        imports: [{ importText: "./derived.js", startLine: 1, importedNames: ["makeDerived"] }],
      }),
    );

    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/base.ts", targetSymbolId: "Base#method" },
    });
  });

  it("prefixes the owner with its enclosing namespaces", () => {
    writeSource(
      repoRoot,
      "src/api.ts",
      [
        `export namespace Api {`,
        `  export class Client {`,
        `    fetchIt(): string {`,
        `      return "x";`,
        `    }`,
        `  }`,
        `}`,
        ``,
        `export function makeClient() {`,
        `  return new Api.Client();`,
        `}`,
        ``,
      ].join("\n"),
    );
    writeSource(
      repoRoot,
      "src/caller.ts",
      [
        `import { makeClient } from "./api.js";`,
        ``,
        `export function run(): string {`,
        `  const x = makeClient();`,
        `  return x.fetchIt();`,
        `}`,
        ``,
      ].join("\n"),
    );
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("src/api.ts", [
      {
        symbolId: "Api.Client#fetchIt",
        fqName: "Api.Client#fetchIt",
        shortName: "fetchIt",
        relPath: "src/api.ts",
        scope: ["Api", "Client"],
      },
      {
        symbolId: "Api.Client.spare",
        fqName: "Api.Client.spare",
        shortName: "fetchIt",
        relPath: "src/api.ts",
        scope: ["Api", "Client"],
      },
    ]);

    const outcome = buildStrategy().attempt(
      { callText: "x.fetchIt()", receiver: "x", member: "fetchIt", startLine: 5 },
      callerContext(symbolTable, {
        imports: [{ importText: "./api.js", startLine: 1, importedNames: ["makeClient"] }],
      }),
    );

    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/api.ts", targetSymbolId: "Api.Client#fetchIt" },
    });
  });

  it("falls back to the member's short name when that file composes the id differently", () => {
    writeDirectFactoryFixture(repoRoot);
    // The chunker recorded `method` under the STATIC form. The checker still
    // names the right file and the right member, so narrowing the short name to
    // that one file recovers the target instead of dropping to a file-only edge.
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("src/foo.ts", [
      { symbolId: "Foo.method", fqName: "Foo.method", shortName: "method", relPath: "src/foo.ts", scope: ["Foo"] },
    ]);
    symbolTable.upsertFile("src/bar.ts", [
      { symbolId: "Bar#method", fqName: "Bar#method", shortName: "method", relPath: "src/bar.ts", scope: ["Bar"] },
    ]);

    const outcome = buildStrategy().attempt(DIRECT_CALL, callerContext(symbolTable));

    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/foo.ts", targetSymbolId: "Foo.method" },
    });
  });

  it("emits a file-only target for a member the project never indexed as a symbol", () => {
    // The half no other pass can reach: with zero same-named definitions the
    // short-name passes have nothing to look up and `typeCheckerFallback` does
    // not classify the call at all, yet the checker still names the file.
    writeDirectFactoryFixture(repoRoot);

    const outcome = buildStrategy().attempt(DIRECT_CALL, callerContext(new InMemoryGlobalSymbolTable()));

    expect(outcome).toEqual({ kind: "resolved", target: { targetRelPath: "src/foo.ts", targetSymbolId: null } });
  });

  it("emits a file-only target when the declaring file carries no matching symbol", () => {
    writeDirectFactoryFixture(repoRoot);
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("src/other.ts", [
      {
        symbolId: "Other#method",
        fqName: "Other#method",
        shortName: "method",
        relPath: "src/other.ts",
        scope: ["Other"],
      },
    ]);

    const outcome = buildStrategy().attempt(DIRECT_CALL, callerContext(symbolTable));

    expect(outcome).toEqual({ kind: "resolved", target: { targetRelPath: "src/foo.ts", targetSymbolId: null } });
  });

  it("drops to a file-only target when one file declares the short name twice under strict mode", () => {
    writeDirectFactoryFixture(repoRoot);
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("src/foo.ts", [
      { symbolId: "Foo.method", fqName: "Foo.method", shortName: "method", relPath: "src/foo.ts", scope: ["Foo"] },
      {
        symbolId: "Helper.method",
        fqName: "Helper.method",
        shortName: "method",
        relPath: "src/foo.ts",
        scope: ["Helper"],
      },
    ]);

    const outcome = buildStrategy("strict").attempt(DIRECT_CALL, callerContext(symbolTable));

    expect(outcome).toEqual({ kind: "resolved", target: { targetRelPath: "src/foo.ts", targetSymbolId: null } });
  });

  it("takes the first same-file candidate under legacy `first` mode", () => {
    writeDirectFactoryFixture(repoRoot);
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("src/foo.ts", [
      { symbolId: "Foo.method", fqName: "Foo.method", shortName: "method", relPath: "src/foo.ts", scope: ["Foo"] },
      {
        symbolId: "Helper.method",
        fqName: "Helper.method",
        shortName: "method",
        relPath: "src/foo.ts",
        scope: ["Helper"],
      },
    ]);

    const outcome = buildStrategy("first").attempt(DIRECT_CALL, callerContext(symbolTable));

    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/foo.ts", targetSymbolId: "Foo.method" },
    });
  });
});

describe("TSTypeCheckerReturnTypeInferenceSymbolResolutionStrategy declines everything it cannot type honestly (bd tea-rags-mcp-l3uob)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-return-type-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function buildStrategy(cache?: TSProgramCache): TSTypeCheckerReturnTypeInferenceSymbolResolutionStrategy {
    const tsOptions = { baseUrl: ".", paths: {} };
    return new TSTypeCheckerReturnTypeInferenceSymbolResolutionStrategy(
      { tsOptions, mode: "strict" },
      cache ?? new TSProgramCache({ repoRoot, tsOptions }),
    );
  }

  it("declines an annotated declaration, which the tree-sitter passes already own", () => {
    writeFooAndBar(repoRoot);
    writeSource(
      repoRoot,
      "src/caller.ts",
      [
        `import { Foo, makeFoo } from "./foo.js";`,
        `import { Bar } from "./bar.js";`,
        ``,
        `export function run(): string {`,
        `  const x: Foo = makeFoo();`,
        `  return x.method();`,
        `}`,
        ``,
      ].join("\n"),
    );

    expect(buildStrategy().attempt(DIRECT_CALL, callerContext(ambiguousMethodTable()))).toEqual({ kind: "continue" });
  });

  it("declines a declaration whose initializer is not a call at all", () => {
    writeFooAndBar(repoRoot);
    writeSource(
      repoRoot,
      "src/caller.ts",
      [
        `import { Foo } from "./foo.js";`,
        `import { Bar } from "./bar.js";`,
        ``,
        `export function run(): string {`,
        `  const x = new Foo();`,
        `  return x.method();`,
        `}`,
        ``,
      ].join("\n"),
    );

    expect(buildStrategy().attempt(DIRECT_CALL, callerContext(ambiguousMethodTable()))).toEqual({ kind: "continue" });
  });

  it("declines a destructured binding", () => {
    writeFooAndBar(repoRoot);
    writeSource(
      repoRoot,
      "src/box.ts",
      [
        `import { Foo } from "./foo.js";`,
        ``,
        `export function makeBox() {`,
        `  return { inner: new Foo() };`,
        `}`,
        ``,
      ].join("\n"),
    );
    writeSource(
      repoRoot,
      "src/caller.ts",
      [
        `import { makeBox } from "./box.js";`,
        `import { Bar } from "./bar.js";`,
        ``,
        `export function run(): string {`,
        `  const { inner } = makeBox();`,
        `  return inner.method();`,
        `}`,
        ``,
      ].join("\n"),
    );

    const outcome = buildStrategy().attempt(
      { callText: "inner.method()", receiver: "inner", member: "method", startLine: 6 },
      callerContext(ambiguousMethodTable()),
    );

    expect(outcome).toEqual({ kind: "continue" });
  });

  it("declines a receiver the walker already bound, without building a Program", () => {
    writeDirectFactoryFixture(repoRoot);
    const cache = new TSProgramCache({ repoRoot, tsOptions: { baseUrl: ".", paths: {} } });

    const outcome = buildStrategy(cache).attempt(
      DIRECT_CALL,
      callerContext(ambiguousMethodTable(), { localBindings: { x: [{ line: 5, type: "Foo" }] } }),
    );

    expect(outcome).toEqual({ kind: "continue" });
    expect(cache.size).toBe(0);
  });

  it("declines a `this.<field>` receiver, which is the field-type pass's case", () => {
    writeDirectFactoryFixture(repoRoot);
    const cache = new TSProgramCache({ repoRoot, tsOptions: { baseUrl: ".", paths: {} } });

    const outcome = buildStrategy(cache).attempt(
      { callText: "this.repo.method()", receiver: "this.repo", member: "method", startLine: 6 },
      callerContext(ambiguousMethodTable()),
    );

    expect(outcome).toEqual({ kind: "continue" });
    expect(cache.size).toBe(0);
  });

  it("declines a free call that has no receiver to type", () => {
    writeDirectFactoryFixture(repoRoot);
    const cache = new TSProgramCache({ repoRoot, tsOptions: { baseUrl: ".", paths: {} } });

    const outcome = buildStrategy(cache).attempt(
      { callText: "method()", receiver: null, member: "method", startLine: 6 },
      callerContext(ambiguousMethodTable()),
    );

    expect(outcome).toEqual({ kind: "continue" });
    expect(cache.size).toBe(0);
  });

  it("declines an ambient global receiver without building a Program", () => {
    writeDirectFactoryFixture(repoRoot);
    const cache = new TSProgramCache({ repoRoot, tsOptions: { baseUrl: ".", paths: {} } });
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("src/a.ts", [
      { symbolId: "A#log", fqName: "A#log", shortName: "log", relPath: "src/a.ts", scope: ["A"] },
    ]);

    const outcome = buildStrategy(cache).attempt(
      { callText: "console.log(x)", receiver: "console", member: "log", startLine: 6 },
      callerContext(symbolTable),
    );

    expect(outcome).toEqual({ kind: "continue" });
    expect(cache.size).toBe(0);
  });

  it("declines when the inferred type's member is declared outside the project", () => {
    writeSource(repoRoot, "src/text.ts", [`export function makeText() {`, `  return "hello";`, `}`, ``].join("\n"));
    writeSource(
      repoRoot,
      "src/caller.ts",
      [
        `import { makeText } from "./text.js";`,
        ``,
        `export function run(): string {`,
        `  const x = makeText();`,
        `  return x.trim();`,
        `}`,
        ``,
      ].join("\n"),
    );
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("src/a.ts", [
      { symbolId: "A#trim", fqName: "A#trim", shortName: "trim", relPath: "src/a.ts", scope: ["A"] },
    ]);

    const outcome = buildStrategy().attempt(
      { callText: "x.trim()", receiver: "x", member: "trim", startLine: 5 },
      callerContext(symbolTable, {
        imports: [{ importText: "./text.js", startLine: 1, importedNames: ["makeText"] }],
      }),
    );

    expect(outcome).toEqual({ kind: "continue" });
  });

  it("declines a union-typed receiver whose member spans two files under strict mode", () => {
    writeFooAndBar(repoRoot);
    writeSource(
      repoRoot,
      "src/pick.ts",
      [
        `import { Foo } from "./foo.js";`,
        `import { Bar } from "./bar.js";`,
        ``,
        `export function pickOne(flag: boolean) {`,
        `  return flag ? new Foo() : new Bar();`,
        `}`,
        ``,
      ].join("\n"),
    );
    writeSource(
      repoRoot,
      "src/caller.ts",
      [
        `import { pickOne } from "./pick.js";`,
        ``,
        `export function run(): string {`,
        `  const x = pickOne(true);`,
        `  return x.method();`,
        `}`,
        ``,
      ].join("\n"),
    );

    const outcome = buildStrategy().attempt(
      { callText: "x.method()", receiver: "x", member: "method", startLine: 5 },
      callerContext(ambiguousMethodTable(), {
        imports: [{ importText: "./pick.js", startLine: 1, importedNames: ["pickOne"] }],
      }),
    );

    expect(outcome).toEqual({ kind: "continue" });
  });

  it("declines when the inferred type has no such member", () => {
    writeFooAndBar(repoRoot);
    // `Foo` declares no `absent`, so the file does not type-check. Diagnostics
    // are never read — what matters is that the checker reports no such property
    // and the pass declines instead of pinning the name to `Foo`'s file anyway.
    writeSource(
      repoRoot,
      "src/caller.ts",
      [
        `import { makeFoo } from "./foo.js";`,
        `import { Bar } from "./bar.js";`,
        ``,
        `export function run() {`,
        `  const x = makeFoo();`,
        `  return x.absent();`,
        `}`,
        ``,
      ].join("\n"),
    );
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("src/foo.ts", [
      { symbolId: "Foo#absent", fqName: "Foo#absent", shortName: "absent", relPath: "src/foo.ts", scope: ["Foo"] },
    ]);

    const outcome = buildStrategy().attempt(
      { callText: "x.absent()", receiver: "x", member: "absent", startLine: 6 },
      callerContext(symbolTable),
    );

    expect(outcome).toEqual({ kind: "continue" });
  });

  it("declines when no Program can be built for the caller file", () => {
    expect(buildStrategy().attempt(DIRECT_CALL, callerContext(ambiguousMethodTable()))).toEqual({ kind: "continue" });
  });

  it("declines when no matching call sits at the recorded line", () => {
    writeDirectFactoryFixture(repoRoot);

    const outcome = buildStrategy().attempt({ ...DIRECT_CALL, startLine: 4 }, callerContext(ambiguousMethodTable()));

    expect(outcome).toEqual({ kind: "continue" });
  });

  it("declines a same-named call on a different receiver at the same line", () => {
    writeFooAndBar(repoRoot);
    writeSource(
      repoRoot,
      "src/caller.ts",
      [
        `import { makeFoo } from "./foo.js";`,
        `import { Bar } from "./bar.js";`,
        ``,
        `export function run(other: Bar): string {`,
        `  const x = makeFoo();`,
        `  return other.method();`,
        `}`,
        ``,
      ].join("\n"),
    );

    expect(buildStrategy().attempt(DIRECT_CALL, callerContext(ambiguousMethodTable()))).toEqual({ kind: "continue" });
  });
});

describe("TSCallResolver reaches the return-type inference pass for calls its tree-sitter chain drops (bd tea-rags-mcp-l3uob)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-return-type-chain-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
    delete process.env.CODEGRAPH_TS_TYPECHECKER;
  });

  it("resolves a factory-bound receiver end to end", () => {
    writeDirectFactoryFixture(repoRoot);
    const resolver = new TSCallResolver({ baseUrl: ".", paths: {} }, "strict", repoRoot);

    const target = resolver.resolve(DIRECT_CALL, callerContext(ambiguousMethodTable()));

    expect(target).toEqual({ targetRelPath: "src/foo.ts", targetSymbolId: "Foo#method" });
  });

  it("recovers a file-only edge no other pass in the chain can produce", () => {
    writeDirectFactoryFixture(repoRoot);
    const resolver = new TSCallResolver({ baseUrl: ".", paths: {} }, "strict", repoRoot);

    const target = resolver.resolve(DIRECT_CALL, callerContext(new InMemoryGlobalSymbolTable()));

    expect(target).toEqual({ targetRelPath: "src/foo.ts", targetSymbolId: null });
  });

  it("leaves the same call unresolved when CODEGRAPH_TS_TYPECHECKER disables the checker tier", () => {
    writeDirectFactoryFixture(repoRoot);
    process.env.CODEGRAPH_TS_TYPECHECKER = "0";
    const resolver = new TSCallResolver({ baseUrl: ".", paths: {} }, "strict", repoRoot);

    const target = resolver.resolve(DIRECT_CALL, callerContext(ambiguousMethodTable()));

    expect(target).toBeNull();
  });
});
