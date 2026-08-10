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
 * One project symbol per colliding short name. `remove` is the taxdome case
 * verbatim: the oracle recorded `stageClientsHandlers.remove(index)` fabricating
 * an edge to a Quill attributor's `remove` (bd tea-rags-mcp-z0zqd). `save` is
 * the recall guard's target — a genuine project class method that a destructured
 * receiver really can reach.
 */
const collidingTable = (): InMemoryGlobalSymbolTable => {
  const table = new InMemoryGlobalSymbolTable();
  table.upsertFile("src/attributor.ts", [
    sym("FontFamilyParchmentStyleAttributor#remove", "remove", "src/attributor.ts", [
      "FontFamilyParchmentStyleAttributor",
    ]),
  ]);
  table.upsertFile("src/store.ts", [sym("ProjectStore#save", "save", "src/store.ts", ["ProjectStore"])]);
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
 * A dependency declaring the hook and the handler object it returns. Written as
 * a real `node_modules` package so the checker resolves the receiver's type to a
 * declaration OUTSIDE the project's own sources, which is what taxdome's
 * `react-hook-form` receiver actually is.
 */
function writeDependencyFixture(repoRoot: string): void {
  writeSource(
    repoRoot,
    "node_modules/react-hook-form/package.json",
    JSON.stringify({ name: "react-hook-form", version: "7.0.0", types: "index.d.ts", main: "index.js" }),
  );
  writeSource(
    repoRoot,
    "node_modules/react-hook-form/index.d.ts",
    [
      `export interface UseFieldArrayHandlers {`,
      `  remove(index: number): void;`,
      `}`,
      ``,
      `export declare function useFieldArray(): { stageClientsHandlers: UseFieldArrayHandlers };`,
      ``,
    ].join("\n"),
  );
  writeSource(repoRoot, "node_modules/react-hook-form/index.js", `export function useFieldArray() {}\n`);
}

/**
 * The bead's headline example. `stageClientsHandlers` is destructured out of a
 * `useFieldArray()` result, so the walker records no `localBindings` entry for
 * it and `receiverTypeName` yields nothing — yet the member `remove` collides
 * with a project symbol, and `globalShortName` committed to it.
 */
function writeDependencyReceiverFixture(repoRoot: string): void {
  writeDependencyFixture(repoRoot);
  writeSource(
    repoRoot,
    "src/client-stage.ts",
    [
      `import { useFieldArray } from "react-hook-form";`,
      ``,
      `export function ClientStage(index: number): void {`,
      `  const { stageClientsHandlers } = useFieldArray();`,
      `  stageClientsHandlers.remove(index);`,
      `}`,
      ``,
    ].join("\n"),
  );
}

const DEPENDENCY_RECEIVER_CALL: CallRef = {
  callText: "stageClientsHandlers.remove(index)",
  receiver: "stageClientsHandlers",
  member: "remove",
  startLine: 5,
};

/**
 * The residual the checker's external arm cannot reach by construction. A
 * destructured PARAMETER with no annotation is `any`: the type has no symbol at
 * all, so `typeDeclaredOutsideProject` answers "no evidence" and correctly
 * declines to call it external — leaving pass 9 to match `remove` against the
 * whole symbol table with nothing standing in the way.
 */
function writeUntypedParameterReceiverFixture(repoRoot: string): void {
  writeSource(
    repoRoot,
    "src/stage-row.ts",
    [`export function StageRow({ handlers }, index) {`, `  handlers.remove(index);`, `}`, ``].join("\n"),
  );
}

const UNTYPED_PARAMETER_RECEIVER_CALL: CallRef = {
  callText: "handlers.remove(index)",
  receiver: "handlers",
  member: "remove",
  startLine: 2,
};

/** The same residual reached through an in-project hook whose return is `any`. */
function writeUntypedHookReceiverFixture(repoRoot: string): void {
  writeSource(
    repoRoot,
    "src/legacy-hooks.ts",
    [`export function useLegacyHandlers(): any {`, `  return {};`, `}`, ``].join("\n"),
  );
  writeSource(
    repoRoot,
    "src/legacy-stage.ts",
    [
      `import { useLegacyHandlers } from "./legacy-hooks.js";`,
      ``,
      `export function LegacyStage(index: number): void {`,
      `  const { handlers } = useLegacyHandlers();`,
      `  handlers.remove(index);`,
      `}`,
      ``,
    ].join("\n"),
  );
}

const UNTYPED_HOOK_RECEIVER_CALL: CallRef = {
  callText: "handlers.remove(index)",
  receiver: "handlers",
  member: "remove",
  startLine: 5,
};

/**
 * The recall guard. Same syntactic shape as every fixture above — a name pulled
 * out of a hook's returned object — but the hook is project code and its return
 * type is a project CLASS. The checker names that declaration, so the edge is
 * real and must survive.
 */
function writeProjectClassReceiverFixture(repoRoot: string): void {
  writeSource(repoRoot, "src/store.ts", [`export class ProjectStore {`, `  save(): void {}`, `}`, ``].join("\n"));
  writeSource(
    repoRoot,
    "src/use-project.ts",
    [
      `import { ProjectStore } from "./store.js";`,
      ``,
      `export function useProjectHook(): { store: ProjectStore } {`,
      `  return { store: new ProjectStore() };`,
      `}`,
      ``,
    ].join("\n"),
  );
  writeSource(
    repoRoot,
    "src/panel.ts",
    [
      `import { useProjectHook } from "./use-project.js";`,
      ``,
      `export function Panel(): void {`,
      `  const { store } = useProjectHook();`,
      `  store.save();`,
      `}`,
      ``,
    ].join("\n"),
  );
}

const PROJECT_CLASS_RECEIVER_CALL: CallRef = {
  callText: "store.save()",
  receiver: "store",
  member: "save",
  startLine: 5,
};

/** An ordinary `const` holding a project instance — a variable, never a binding element. */
function writeOrdinaryLocalReceiverFixture(repoRoot: string): void {
  writeSource(repoRoot, "src/store.ts", [`export class ProjectStore {`, `  save(): void {}`, `}`, ``].join("\n"));
  writeSource(
    repoRoot,
    "src/dashboard.ts",
    [
      `import { ProjectStore } from "./store.js";`,
      ``,
      `export function Dashboard(): void {`,
      `  const store = new ProjectStore();`,
      `  store.save();`,
      `}`,
      ``,
    ].join("\n"),
  );
}

const ORDINARY_LOCAL_RECEIVER_CALL: CallRef = {
  callText: "store.save()",
  receiver: "store",
  member: "save",
  startLine: 5,
};

/**
 * bd tea-rags-mcp-z0zqd — the RECEIVER twin of the local-callee guard.
 *
 * bd tea-rags-mcp-5tatv closed the bare-call half: `calleeIsLocalValueBinding`
 * returns `false` the moment `call.receiver !== null`, by construction, because
 * it identifies the CALLEE identifier. A dynamic-dispatch receiver that is
 * ITSELF a destructured local goes through the same blind spot untouched — the
 * walker skips destructuring patterns when building `localBindings`, so
 * `receiverTypeName` yields nothing and the external guard's receiver arms have
 * no annotation to decide on.
 *
 * The checker-backed arm does run, and it answers the half it can: a receiver
 * typed by a dependency IS declared outside the project. What it cannot answer
 * is a receiver with no resolvable type at all — `any`, an unannotated
 * destructured parameter, an unresolved import. There
 * `typeDeclaredOutsideProject` returns "no evidence" by design, since that arm
 * may only ever ADD an external verdict, and pass 9 went on to match the bare
 * member name against the whole symbol table.
 */
describe("TSGlobalShortNameSymbolResolutionStrategy — local-receiver guard (bd tea-rags-mcp-z0zqd)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-local-receiver-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const strategy = (): TSGlobalShortNameSymbolResolutionStrategy =>
    new TSGlobalShortNameSymbolResolutionStrategy(cfg, new TSProgramCache({ repoRoot, tsOptions }));

  it("continues for a destructured receiver typed by a dependency (ClientStage stageClientsHandlers.remove(index))", () => {
    writeDependencyReceiverFixture(repoRoot);
    expect(strategy().attempt(DEPENDENCY_RECEIVER_CALL, ctx("src/client-stage.ts")).kind).toBe("continue");
  });

  it("continues for an unannotated destructured parameter (StageRow handlers.remove(index))", () => {
    writeUntypedParameterReceiverFixture(repoRoot);
    expect(strategy().attempt(UNTYPED_PARAMETER_RECEIVER_CALL, ctx("src/stage-row.ts")).kind).toBe("continue");
  });

  it("continues for a receiver destructured out of an `any`-returning project hook", () => {
    writeUntypedHookReceiverFixture(repoRoot);
    expect(strategy().attempt(UNTYPED_HOOK_RECEIVER_CALL, ctx("src/legacy-stage.ts")).kind).toBe("continue");
  });

  it("STILL resolves a destructured receiver the checker types as a project class (Panel store.save())", () => {
    writeProjectClassReceiverFixture(repoRoot);
    expect(strategy().attempt(PROJECT_CLASS_RECEIVER_CALL, ctx("src/panel.ts"))).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/store.ts", targetSymbolId: "ProjectStore#save" },
    });
  });

  it("STILL resolves an ordinary local variable receiver — a variable is not a binding element", () => {
    writeOrdinaryLocalReceiverFixture(repoRoot);
    expect(strategy().attempt(ORDINARY_LOCAL_RECEIVER_CALL, ctx("src/dashboard.ts"))).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/store.ts", targetSymbolId: "ProjectStore#save" },
    });
  });

  it("STILL resolves when no Program can be built for the caller file (nothing on disk)", () => {
    expect(strategy().attempt(UNTYPED_PARAMETER_RECEIVER_CALL, ctx("src/stage-row.ts"))).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/attributor.ts", targetSymbolId: "FontFamilyParchmentStyleAttributor#remove" },
    });
  });

  it("STILL resolves when the recorded line holds no such call — a node it cannot locate decides nothing", () => {
    writeUntypedParameterReceiverFixture(repoRoot);
    const call: CallRef = { ...UNTYPED_PARAMETER_RECEIVER_CALL, startLine: 1 };
    expect(strategy().attempt(call, ctx("src/stage-row.ts"))).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/attributor.ts", targetSymbolId: "FontFamilyParchmentStyleAttributor#remove" },
    });
  });

  it("behaves exactly as before when no Program cache is injected (the disabled state)", () => {
    writeUntypedParameterReceiverFixture(repoRoot);
    expect(
      new TSGlobalShortNameSymbolResolutionStrategy(cfg, null).attempt(
        UNTYPED_PARAMETER_RECEIVER_CALL,
        ctx("src/stage-row.ts"),
      ),
    ).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/attributor.ts", targetSymbolId: "FontFamilyParchmentStyleAttributor#remove" },
    });
  });
});

/**
 * bd tea-rags-mcp-z0zqd — the import-narrowed sibling needs the guard for the
 * same reason pass 9 does: narrowing an ambiguous short name by the caller's
 * imports turns a guess into a committed answer.
 */
describe("TSImportNarrowedFallbackSymbolResolutionStrategy — local-receiver guard (bd tea-rags-mcp-z0zqd)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-local-receiver-narrowed-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  /** Two project `remove`s, one in a file the caller imports — the narrowing shape. */
  const ambiguousTable = (): InMemoryGlobalSymbolTable => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("src/attributor.ts", [
      sym("FontFamilyParchmentStyleAttributor#remove", "remove", "src/attributor.ts", [
        "FontFamilyParchmentStyleAttributor",
      ]),
    ]);
    table.upsertFile("src/other.ts", [sym("OtherPanel#remove", "remove", "src/other.ts", ["OtherPanel"])]);
    return table;
  };

  it("continues for an unannotated destructured parameter rather than narrowing to the imported `remove`", () => {
    writeUntypedParameterReceiverFixture(repoRoot);
    writeSource(repoRoot, "src/attributor.ts", [`export class FontFamilyParchmentStyleAttributor {}`, ``].join("\n"));

    const outcome = new TSImportNarrowedFallbackSymbolResolutionStrategy(
      cfg,
      new TSProgramCache({ repoRoot, tsOptions }),
    ).attempt(
      UNTYPED_PARAMETER_RECEIVER_CALL,
      ctx("src/stage-row.ts", {
        symbolTable: ambiguousTable(),
        imports: [
          { importText: "./attributor.js", startLine: 1, importedNames: ["FontFamilyParchmentStyleAttributor"] },
        ],
      }),
    );

    expect(outcome.kind).toBe("continue");
  });
});

/**
 * bd tea-rags-mcp-z0zqd — the same decision through the whole chain.
 *
 * The classifier half is asserted in BOTH directions on purpose, because the two
 * populations belong in different denominators. A receiver the checker types to
 * a dependency IS an external call and leaves the internal denominator. A
 * receiver nothing can type is NOT — it is very often project code we simply
 * cannot pin, so it stays an internal miss and the guard buys precision without
 * flattering `resolveSuccessRate`.
 */
describe("TSCallResolver — local-receiver guard end to end (bd tea-rags-mcp-z0zqd)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-local-receiver-e2e-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("emits no edge for the taxdome receiver (stageClientsHandlers.remove(index))", () => {
    writeDependencyReceiverFixture(repoRoot);
    const resolver = new TSCallResolver(tsOptions, DEFAULT_AMBIGUOUS_RESOLVE_MODE, repoRoot);
    expect(resolver.resolve(DEPENDENCY_RECEIVER_CALL, ctx("src/client-stage.ts"))).toBeNull();
  });

  it("emits no edge for an unannotated destructured parameter (handlers.remove(index))", () => {
    writeUntypedParameterReceiverFixture(repoRoot);
    const resolver = new TSCallResolver(tsOptions, DEFAULT_AMBIGUOUS_RESOLVE_MODE, repoRoot);
    expect(resolver.resolve(UNTYPED_PARAMETER_RECEIVER_CALL, ctx("src/stage-row.ts"))).toBeNull();
  });

  it("keeps an untypable receiver in the internal denominator — unpinnable is not external", () => {
    writeUntypedParameterReceiverFixture(repoRoot);
    const resolver = new TSCallResolver(tsOptions, DEFAULT_AMBIGUOUS_RESOLVE_MODE, repoRoot);
    expect(resolver.targetsExternalImport(UNTYPED_PARAMETER_RECEIVER_CALL, ctx("src/stage-row.ts"))).toBe(false);
  });

  it("STILL emits the real edge for a destructured receiver typed as a project class", () => {
    writeProjectClassReceiverFixture(repoRoot);
    const resolver = new TSCallResolver(tsOptions, DEFAULT_AMBIGUOUS_RESOLVE_MODE, repoRoot);
    expect(resolver.resolve(PROJECT_CLASS_RECEIVER_CALL, ctx("src/panel.ts"))).toEqual({
      targetRelPath: "src/store.ts",
      targetSymbolId: "ProjectStore#save",
    });
  });

  it("CODEGRAPH_TS_TYPECHECKER=0 keeps the chain exactly as it was — no checker involvement", () => {
    writeUntypedParameterReceiverFixture(repoRoot);
    const previous = process.env.CODEGRAPH_TS_TYPECHECKER;
    process.env.CODEGRAPH_TS_TYPECHECKER = "0";
    try {
      const resolver = new TSCallResolver(tsOptions, DEFAULT_AMBIGUOUS_RESOLVE_MODE, repoRoot);
      expect(resolver.programCache).toBeNull();
      expect(resolver.resolve(UNTYPED_PARAMETER_RECEIVER_CALL, ctx("src/stage-row.ts"))).toEqual({
        targetRelPath: "src/attributor.ts",
        targetSymbolId: "FontFamilyParchmentStyleAttributor#remove",
      });
    } finally {
      if (previous === undefined) delete process.env.CODEGRAPH_TS_TYPECHECKER;
      else process.env.CODEGRAPH_TS_TYPECHECKER = previous;
    }
  });
});
