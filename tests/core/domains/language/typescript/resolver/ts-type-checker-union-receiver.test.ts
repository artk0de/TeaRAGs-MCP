import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  CallContext,
  CallRef,
  DispatchEdge,
  DispatchFanoutOutcome,
  NamedSymbol,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import { TSTypeCheckerUnionReceiverDispatchResolver } from "../../../../../../src/core/domains/language/typescript/resolver/strategies/ts-type-checker-union-receiver.js";
import { TSProgramCache } from "../../../../../../src/core/domains/language/typescript/resolver/ts-program-cache.js";
import { TSCallResolver } from "../../../../../../src/core/domains/language/typescript/resolver/ts-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const TS_OPTIONS = { baseUrl: ".", paths: {} };

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

const tableWith = (...files: [string, NamedSymbol[]][]): InMemoryGlobalSymbolTable => {
  const table = new InMemoryGlobalSymbolTable();
  for (const [relPath, defs] of files) table.upsertFile(relPath, defs);
  return table;
};

/** Unwrap the fan-out payload; a non-`edges` outcome is a hard failure here. */
const edgesOf = (outcome: DispatchFanoutOutcome): DispatchEdge[] => {
  if (outcome.kind !== "edges") throw new Error(`expected edges outcome, got ${outcome.kind}`);
  return outcome.edges;
};

const sortEdges = (edges: DispatchEdge[]): DispatchEdge[] =>
  [...edges].sort((a, b) => (a.targetSymbolId ?? "").localeCompare(b.targetSymbolId ?? ""));

const A_FILE: [string, NamedSymbol[]] = [
  "src/a.ts",
  [sym("A", "A", "src/a.ts", []), sym("A#process", "process", "src/a.ts", ["A"])],
];
const B_FILE: [string, NamedSymbol[]] = [
  "src/b.ts",
  [sym("B", "B", "src/b.ts", []), sym("B#process", "process", "src/b.ts", ["B"])],
];

/** `A` and `B` both declare `process` — the two branches a union fans out to. */
function writeTwoBranchClasses(repoRoot: string): void {
  writeSource(repoRoot, "src/a.ts", `export class A {\n  process(): string {\n    return "a";\n  }\n}\n`);
  writeSource(repoRoot, "src/b.ts", `export class B {\n  process(): string {\n    return "b";\n  }\n}\n`);
}

/**
 * Receiver declared `A | B` and never narrowed. Tree-sitter records no type for
 * a union annotation at all, so nothing ahead of the checker can see either
 * branch. The call sits on line 5.
 */
function writeUnnarrowedFixture(repoRoot: string): void {
  writeTwoBranchClasses(repoRoot);
  writeSource(
    repoRoot,
    "src/caller.ts",
    [
      `import { A } from "./a.js";`,
      `import { B } from "./b.js";`,
      ``,
      `export function run(x: A | B): string {`,
      `  return x.process();`,
      `}`,
      ``,
    ].join("\n"),
  );
}

const UNNARROWED_CALL: CallRef = { callText: "x.process()", receiver: "x", member: "process", startLine: 5 };

const callerImports = (): CallContext["imports"] => [
  { importText: "./a.js", startLine: 1, importedNames: ["A"] },
  { importText: "./b.js", startLine: 2, importedNames: ["B"] },
];

const callerContext = (symbolTable: InMemoryGlobalSymbolTable): CallContext => ({
  callerFile: "src/caller.ts",
  callerScope: [],
  imports: callerImports(),
  symbolTable,
});

describe("TSTypeCheckerUnionReceiverDispatchResolver fans an unnarrowed union out to every branch (bd tea-rags-mcp-3yj7d)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-union-receiver-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function buildResolver(coneMax?: number): TSTypeCheckerUnionReceiverDispatchResolver {
    return new TSTypeCheckerUnionReceiverDispatchResolver(
      { tsOptions: TS_OPTIONS, mode: "strict", coneMax },
      new TSProgramCache({ repoRoot, tsOptions: TS_OPTIONS }),
    );
  }

  it("emits one cone edge per branch, unit weight shared as 1/N", () => {
    writeUnnarrowedFixture(repoRoot);

    const edges = edgesOf(buildResolver().resolveDispatch(UNNARROWED_CALL, callerContext(tableWith(A_FILE, B_FILE))));

    expect(sortEdges(edges)).toEqual([
      {
        sourceSymbolId: null,
        targetRelPath: "src/a.ts",
        targetSymbolId: "A#process",
        edgeKind: "cone",
        confidence: 0.5,
      },
      {
        sourceSymbolId: null,
        targetRelPath: "src/b.ts",
        targetSymbolId: "B#process",
        edgeKind: "cone",
        confidence: 0.5,
      },
    ]);
  });

  it("counts only the branches the symbol table confirms, so an unknown branch never becomes an edge", () => {
    writeUnnarrowedFixture(repoRoot);

    const edges = edgesOf(buildResolver().resolveDispatch(UNNARROWED_CALL, callerContext(tableWith(A_FILE))));

    expect(edges).toEqual([
      { sourceSymbolId: null, targetRelPath: "src/a.ts", targetSymbolId: "A#process", edgeKind: "cone", confidence: 1 },
    ]);
  });

  it("deduplicates branches that inherit the same declaration", () => {
    writeSource(repoRoot, "src/a.ts", `export class A {\n  process(): string {\n    return "a";\n  }\n}\n`);
    writeSource(
      repoRoot,
      "src/b.ts",
      `import { A } from "./a.js";\n\nexport class B extends A {\n  extra(): string {\n    return "b";\n  }\n}\n`,
    );
    writeSource(
      repoRoot,
      "src/caller.ts",
      [
        `import { A } from "./a.js";`,
        `import { B } from "./b.js";`,
        ``,
        `export function run(x: A | B): string {`,
        `  return x.process();`,
        `}`,
        ``,
      ].join("\n"),
    );

    const edges = edgesOf(
      buildResolver().resolveDispatch(
        UNNARROWED_CALL,
        callerContext(tableWith(A_FILE, ["src/b.ts", [sym("B", "B", "src/b.ts", [])]])),
      ),
    );

    expect(edges).toEqual([
      { sourceSymbolId: null, targetRelPath: "src/a.ts", targetSymbolId: "A#process", edgeKind: "cone", confidence: 1 },
    ]);
  });

  it("declines a fan-out wider than the cone cap rather than guessing a base type", () => {
    writeUnnarrowedFixture(repoRoot);

    const edges = edgesOf(buildResolver(1).resolveDispatch(UNNARROWED_CALL, callerContext(tableWith(A_FILE, B_FILE))));

    expect(edges).toEqual([]);
  });

  it("emits nothing when no branch resolves to an in-project declaration", () => {
    writeUnnarrowedFixture(repoRoot);

    const edges = edgesOf(
      buildResolver().resolveDispatch(UNNARROWED_CALL, callerContext(new InMemoryGlobalSymbolTable())),
    );

    expect(edges).toEqual([]);
  });
});

describe("TSTypeCheckerUnionReceiverDispatchResolver pins a guard-narrowed receiver to one branch (bd tea-rags-mcp-3yj7d)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-union-narrowed-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function buildResolver(): TSTypeCheckerUnionReceiverDispatchResolver {
    return new TSTypeCheckerUnionReceiverDispatchResolver(
      { tsOptions: TS_OPTIONS, mode: "strict" },
      new TSProgramCache({ repoRoot, tsOptions: TS_OPTIONS }),
    );
  }

  it("emits a single exact edge when instanceof narrows the union to one branch", () => {
    writeTwoBranchClasses(repoRoot);
    writeSource(
      repoRoot,
      "src/caller.ts",
      [
        `import { A } from "./a.js";`,
        `import { B } from "./b.js";`,
        ``,
        `export function run(x: A | B): string {`,
        `  if (x instanceof A) {`,
        `    return x.process();`,
        `  }`,
        `  return "";`,
        `}`,
        ``,
      ].join("\n"),
    );

    const edges = edgesOf(
      buildResolver().resolveDispatch(
        { callText: "x.process()", receiver: "x", member: "process", startLine: 6 },
        callerContext(tableWith(A_FILE, B_FILE)),
      ),
    );

    expect(edges).toEqual([
      {
        sourceSymbolId: null,
        targetRelPath: "src/a.ts",
        targetSymbolId: "A#process",
        edgeKind: "exact",
        confidence: 1,
      },
    ]);
  });

  it("emits a single exact edge when a discriminant field narrows the union", () => {
    writeSource(
      repoRoot,
      "src/shapes.ts",
      [
        `export class Circle {`,
        `  kind: "circle" = "circle";`,
        `  area(): number {`,
        `    return 1;`,
        `  }`,
        `}`,
        ``,
        `export class Square {`,
        `  kind: "square" = "square";`,
        `  area(): number {`,
        `    return 2;`,
        `  }`,
        `}`,
        ``,
      ].join("\n"),
    );
    writeSource(
      repoRoot,
      "src/caller.ts",
      [
        `import { Circle, Square } from "./shapes.js";`,
        ``,
        `export function run(s: Circle | Square): number {`,
        `  if (s.kind === "circle") {`,
        `    return s.area();`,
        `  }`,
        `  return 0;`,
        `}`,
        ``,
      ].join("\n"),
    );

    const edges = edgesOf(
      buildResolver().resolveDispatch(
        { callText: "s.area()", receiver: "s", member: "area", startLine: 5 },
        {
          callerFile: "src/caller.ts",
          callerScope: [],
          imports: [{ importText: "./shapes.js", startLine: 1, importedNames: ["Circle", "Square"] }],
          symbolTable: tableWith([
            "src/shapes.ts",
            [
              sym("Circle#area", "area", "src/shapes.ts", ["Circle"]),
              sym("Square#area", "area", "src/shapes.ts", ["Square"]),
            ],
          ]),
        },
      ),
    );

    expect(edges).toEqual([
      {
        sourceSymbolId: null,
        targetRelPath: "src/shapes.ts",
        targetSymbolId: "Circle#area",
        edgeKind: "exact",
        confidence: 1,
      },
    ]);
  });

  it("leaves a branch narrowed onto a runtime builtin to the external classifier", () => {
    writeSource(repoRoot, "src/a.ts", `export class A {\n  process(): string {\n    return "a";\n  }\n}\n`);
    writeSource(
      repoRoot,
      "src/caller.ts",
      [
        `import { A } from "./a.js";`,
        ``,
        `export function run(x: string | A): string {`,
        `  if (typeof x === "string") {`,
        `    return x.trim();`,
        `  }`,
        `  return x.process();`,
        `}`,
        ``,
      ].join("\n"),
    );
    const symbolTable = tableWith(A_FILE, ["src/decoy.ts", [sym("Decoy#trim", "trim", "src/decoy.ts", ["Decoy"])]]);
    const ctx: CallContext = {
      callerFile: "src/caller.ts",
      callerScope: [],
      imports: [{ importText: "./a.js", startLine: 1, importedNames: ["A"] }],
      symbolTable,
    };
    const resolver = buildResolver();

    expect(
      edgesOf(resolver.resolveDispatch({ callText: "x.trim()", receiver: "x", member: "trim", startLine: 5 }, ctx)),
    ).toEqual([]);
    expect(
      edgesOf(
        resolver.resolveDispatch({ callText: "x.process()", receiver: "x", member: "process", startLine: 7 }, ctx),
      ),
    ).toEqual([
      {
        sourceSymbolId: null,
        targetRelPath: "src/a.ts",
        targetSymbolId: "A#process",
        edgeKind: "exact",
        confidence: 1,
      },
    ]);
  });
});

describe("TSTypeCheckerUnionReceiverDispatchResolver leaves every non-union call to the existing chain (bd tea-rags-mcp-3yj7d)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-union-decline-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function buildResolver(): TSTypeCheckerUnionReceiverDispatchResolver {
    return new TSTypeCheckerUnionReceiverDispatchResolver(
      { tsOptions: TS_OPTIONS, mode: "strict" },
      new TSProgramCache({ repoRoot, tsOptions: TS_OPTIONS }),
    );
  }

  it("declines a receiver whose declared type is a single class", () => {
    writeTwoBranchClasses(repoRoot);
    writeSource(
      repoRoot,
      "src/caller.ts",
      [`import { A } from "./a.js";`, ``, `export function run(x: A): string {`, `  return x.process();`, `}`, ``].join(
        "\n",
      ),
    );

    const edges = edgesOf(
      buildResolver().resolveDispatch(
        { callText: "x.process()", receiver: "x", member: "process", startLine: 4 },
        callerContext(tableWith(A_FILE, B_FILE)),
      ),
    );

    expect(edges).toEqual([]);
  });

  it("declines a bare call with no receiver without building a Program", () => {
    writeUnnarrowedFixture(repoRoot);
    const cache = new TSProgramCache({ repoRoot, tsOptions: TS_OPTIONS });
    const resolver = new TSTypeCheckerUnionReceiverDispatchResolver({ tsOptions: TS_OPTIONS, mode: "strict" }, cache);

    const edges = edgesOf(
      resolver.resolveDispatch(
        { callText: "process()", receiver: null, member: "process", startLine: 5 },
        callerContext(tableWith(A_FILE, B_FILE)),
      ),
    );

    expect(edges).toEqual([]);
    expect(cache.size).toBe(0);
  });

  it("declines when the caller file is not on disk", () => {
    const edges = edgesOf(buildResolver().resolveDispatch(UNNARROWED_CALL, callerContext(tableWith(A_FILE, B_FILE))));

    expect(edges).toEqual([]);
  });

  it("declines when no call expression sits at the recorded line", () => {
    writeUnnarrowedFixture(repoRoot);

    const edges = edgesOf(
      buildResolver().resolveDispatch({ ...UNNARROWED_CALL, startLine: 4 }, callerContext(tableWith(A_FILE, B_FILE))),
    );

    expect(edges).toEqual([]);
  });
});

describe("TSCallResolver routes union receivers through the checker before the CHA cone (bd tea-rags-mcp-3yj7d)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-union-chain-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
    delete process.env.CODEGRAPH_TS_TYPECHECKER;
  });

  it("fans the union out instead of letting the chain pick one branch", () => {
    writeUnnarrowedFixture(repoRoot);
    const resolver = new TSCallResolver(TS_OPTIONS, "strict", repoRoot);

    const edges = edgesOf(resolver.resolveDispatch(UNNARROWED_CALL, callerContext(tableWith(A_FILE, B_FILE))));

    expect(sortEdges(edges).map((edge) => edge.targetSymbolId)).toEqual(["A#process", "B#process"]);
    expect(edges.every((edge) => edge.edgeKind === "cone" && edge.confidence === 0.5)).toBe(true);
  });

  it("emits no fan-out when CODEGRAPH_TS_TYPECHECKER disables the checker passes", () => {
    writeUnnarrowedFixture(repoRoot);
    process.env.CODEGRAPH_TS_TYPECHECKER = "0";
    const resolver = new TSCallResolver(TS_OPTIONS, "strict", repoRoot);

    const edges = edgesOf(resolver.resolveDispatch(UNNARROWED_CALL, callerContext(tableWith(A_FILE, B_FILE))));

    expect(edges).toEqual([]);
  });
});
