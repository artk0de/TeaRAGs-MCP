import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type CallRef,
  type SymbolDefinition,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import {
  TSCallResultCalleeSymbolResolutionStrategy,
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

const sym = (symbolId: string, shortName: string, relPath: string, scope: string[]): SymbolDefinition => ({
  symbolId,
  fqName: symbolId,
  shortName,
  relPath,
  scope,
});

/**
 * Shape (a) — `useResolverGuards` verbatim from taxdome: a hook returning an
 * object whose members are function-scoped `const` arrows, destructured and
 * called bare in another file. Post-29m75 the closure IS a symbol
 * (`useResolverGuards.checkGuards`); nothing in the chain could reach it.
 */
function writeHookDestructureFixture(repoRoot: string): void {
  writeSource(
    repoRoot,
    "src/use-resolver-guards.ts",
    [
      `export function useResolverGuards() {`,
      `  const checkGuards = (results: (string | undefined)[]): string | undefined => results.find((r) => r);`,
      `  return { checkGuards };`,
      `}`,
      ``,
    ].join("\n"),
  );
  writeSource(
    repoRoot,
    "src/activity-feed-resolver.ts",
    [
      `import { useResolverGuards } from "./use-resolver-guards.js";`,
      ``,
      `export function ActivityFeedResolver(): string | undefined {`,
      `  const { checkGuards } = useResolverGuards();`,
      `  return checkGuards(["activityFeed"]);`,
      `}`,
      ``,
    ].join("\n"),
  );
}

const HOOK_DESTRUCTURE_CALL: CallRef = {
  callText: 'checkGuards(["activityFeed"])',
  receiver: null,
  member: "checkGuards",
  startLine: 5,
};

const hookDestructureTable = (): InMemoryGlobalSymbolTable => {
  const table = new InMemoryGlobalSymbolTable();
  table.upsertFile("src/use-resolver-guards.ts", [
    sym("useResolverGuards", "useResolverGuards", "src/use-resolver-guards.ts", []),
    sym("useResolverGuards.checkGuards", "checkGuards", "src/use-resolver-guards.ts", ["useResolverGuards"]),
  ]);
  return table;
};

/**
 * Shape (b) — `scopedTranslation` verbatim from taxdome: a project factory
 * returning a nested named function, bound to a MODULE-level const under an
 * arbitrary local name and invoked. The callee name (`tButton`) exists nowhere
 * in the project, so no name-matching pass can ever answer it — and the binding
 * sits outside every chunk, which is why the walker's per-chunk channels cannot
 * carry it either.
 */
function writeCallResultConstFixture(repoRoot: string): void {
  writeSource(
    repoRoot,
    "src/localization-helper.ts",
    [
      `export function scopedTranslation(scope: string) {`,
      `  function t(key: string): string {`,
      `    return scope + "." + key;`,
      `  }`,
      ``,
      `  return t;`,
      `}`,
      ``,
    ].join("\n"),
  );
  writeSource(
    repoRoot,
    "src/action-modal.ts",
    [
      `import { scopedTranslation } from "./localization-helper.js";`,
      ``,
      `const tButton = scopedTranslation("frontend.buttons");`,
      ``,
      `export function ActionModal(): string {`,
      `  return tButton("cancel");`,
      `}`,
      ``,
    ].join("\n"),
  );
}

const CALL_RESULT_CONST_CALL: CallRef = {
  callText: 'tButton("cancel")',
  receiver: null,
  member: "tButton",
  startLine: 6,
};

const callResultConstTable = (): InMemoryGlobalSymbolTable => {
  const table = new InMemoryGlobalSymbolTable();
  table.upsertFile("src/localization-helper.ts", [
    sym("scopedTranslation", "scopedTranslation", "src/localization-helper.ts", []),
    sym("scopedTranslation.t", "t", "src/localization-helper.ts", ["scopedTranslation"]),
  ]);
  return table;
};

/**
 * The recall guard: a bare call to an IMPORTED PROJECT FUNCTION. Same syntactic
 * shape, and the single most common way TypeScript reaches another module.
 * `importedCallee` (pass 6) owns it and nothing in the checker tier may take it.
 */
const IMPORTED_HOOK_CALL: CallRef = {
  callText: "useResolverGuards()",
  receiver: null,
  member: "useResolverGuards",
  startLine: 4,
};

const ctxFor = (callerFile: string, table: InMemoryGlobalSymbolTable, importText: string): CallContext => ({
  callerFile,
  callerScope: [],
  imports: [{ importText, startLine: 1, importedNames: [] }],
  symbolTable: table,
});

/**
 * bd tea-rags-mcp-kf42k — a bare call whose callee is a local binding produced
 * by CALLING a project function.
 *
 * The two shapes are one defect. `const { checkGuards } = useResolverGuards()`
 * and `const tButton = scopedTranslation(scope)` both hand the enclosing scope a
 * value no name in the project matches: the first collides with an unrelated
 * short name (which is why `calleeIsLocalValueBinding` declines it, bd
 * tea-rags-mcp-5tatv), the second carries a name the symbol table has never
 * heard of. Post-29m75 the TARGET exists on both sides — `useResolverGuards.checkGuards`,
 * `scopedTranslation.t` — and the checker names the exact declaration.
 */
describe("TSCallResultCalleeSymbolResolutionStrategy — callee bound from a call result (bd tea-rags-mcp-kf42k)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-call-result-callee-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const strategy = (): TSCallResultCalleeSymbolResolutionStrategy =>
    new TSCallResultCalleeSymbolResolutionStrategy(cfg, new TSProgramCache({ repoRoot, tsOptions }));

  it("resolves a hook member destructured off a call result (checkGuards)", () => {
    writeHookDestructureFixture(repoRoot);

    expect(
      strategy().attempt(
        HOOK_DESTRUCTURE_CALL,
        ctxFor("src/activity-feed-resolver.ts", hookDestructureTable(), "./use-resolver-guards.js"),
      ),
    ).toEqual({
      kind: "resolved",
      target: {
        targetRelPath: "src/use-resolver-guards.ts",
        targetSymbolId: "useResolverGuards.checkGuards",
      },
    });
  });

  it("resolves a module-level const bound to a factory's returned callable (tButton)", () => {
    writeCallResultConstFixture(repoRoot);

    expect(
      strategy().attempt(
        CALL_RESULT_CONST_CALL,
        ctxFor("src/action-modal.ts", callResultConstTable(), "./localization-helper.js"),
      ),
    ).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/localization-helper.ts", targetSymbolId: "scopedTranslation.t" },
    });
  });

  it("DECLINES when the symbol table has no definition for the declaration the checker named", () => {
    writeHookDestructureFixture(repoRoot);
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("src/use-resolver-guards.ts", [
      sym("useResolverGuards", "useResolverGuards", "src/use-resolver-guards.ts", []),
    ]);

    expect(
      strategy().attempt(
        HOOK_DESTRUCTURE_CALL,
        ctxFor("src/activity-feed-resolver.ts", table, "./use-resolver-guards.js"),
      ).kind,
    ).toBe("continue");
  });

  it("DECLINES when the declaring file holds two definitions of that short name", () => {
    writeHookDestructureFixture(repoRoot);
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("src/use-resolver-guards.ts", [
      sym("useResolverGuards", "useResolverGuards", "src/use-resolver-guards.ts", []),
      sym("useResolverGuards.checkGuards", "checkGuards", "src/use-resolver-guards.ts", ["useResolverGuards"]),
      sym("useOtherGuards.checkGuards", "checkGuards", "src/use-resolver-guards.ts", ["useOtherGuards"]),
    ]);

    expect(
      strategy().attempt(
        HOOK_DESTRUCTURE_CALL,
        ctxFor("src/activity-feed-resolver.ts", table, "./use-resolver-guards.js"),
      ).kind,
    ).toBe("continue");
  });

  it("DECLINES a callee the enclosing scope was HANDED — a destructured prop is not a call result", () => {
    writeSource(
      repoRoot,
      "src/attachment-row.ts",
      [
        `export interface AttachmentRowProps {`,
        `  onRemove: (id: string) => void;`,
        `}`,
        ``,
        `export function AttachmentRow({ onRemove }: AttachmentRowProps): void {`,
        `  onRemove("1");`,
        `}`,
        ``,
      ].join("\n"),
    );
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("src/tooltip.ts", [sym("Tooltip#onRemove", "onRemove", "src/tooltip.ts", ["Tooltip"])]);
    const call: CallRef = { callText: 'onRemove("1")', receiver: null, member: "onRemove", startLine: 6 };

    expect(strategy().attempt(call, ctxFor("src/attachment-row.ts", table, "./tooltip.js")).kind).toBe("continue");
  });

  it("DECLINES a receiver-shaped call outright — this pass answers bare calls only", () => {
    writeCallResultConstFixture(repoRoot);
    const call: CallRef = { ...CALL_RESULT_CONST_CALL, receiver: "helper" };

    expect(
      strategy().attempt(call, ctxFor("src/action-modal.ts", callResultConstTable(), "./localization-helper.js")).kind,
    ).toBe("continue");
  });
});

/**
 * bd tea-rags-mcp-kf42k — the same decision through the whole chain, which is
 * where the pass's POSITION is asserted.
 *
 * It sits in the checker tier and therefore sees only calls every cheaper pass
 * declined: a bare call to an imported project function is answered by
 * `importedCallee` (6) and must keep that answer, and disabling the checker
 * tier must leave the chain byte-identical.
 */
describe("TSCallResolver — call-result callee end to end (bd tea-rags-mcp-kf42k)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-call-result-callee-e2e-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("emits the nested closure edge for a destructured hook member", () => {
    writeHookDestructureFixture(repoRoot);
    const resolver = new TSCallResolver(tsOptions, DEFAULT_AMBIGUOUS_RESOLVE_MODE, repoRoot);

    expect(
      resolver.resolve(
        HOOK_DESTRUCTURE_CALL,
        ctxFor("src/activity-feed-resolver.ts", hookDestructureTable(), "./use-resolver-guards.js"),
      ),
    ).toEqual({ targetRelPath: "src/use-resolver-guards.ts", targetSymbolId: "useResolverGuards.checkGuards" });
  });

  it("emits the nested function edge for a module-level factory binding", () => {
    writeCallResultConstFixture(repoRoot);
    const resolver = new TSCallResolver(tsOptions, DEFAULT_AMBIGUOUS_RESOLVE_MODE, repoRoot);

    expect(
      resolver.resolve(
        CALL_RESULT_CONST_CALL,
        ctxFor("src/action-modal.ts", callResultConstTable(), "./localization-helper.js"),
      ),
    ).toEqual({ targetRelPath: "src/localization-helper.ts", targetSymbolId: "scopedTranslation.t" });
  });

  it("leaves the imported-hook call itself to `importedCallee` — the checker tier never preempts it", () => {
    writeHookDestructureFixture(repoRoot);
    const resolver = new TSCallResolver(tsOptions, DEFAULT_AMBIGUOUS_RESOLVE_MODE, repoRoot);

    expect(
      resolver.resolve(
        IMPORTED_HOOK_CALL,
        ctxFor("src/activity-feed-resolver.ts", hookDestructureTable(), "./use-resolver-guards.js"),
      ),
    ).toEqual({ targetRelPath: "src/use-resolver-guards.ts", targetSymbolId: "useResolverGuards" });
  });

  it("CODEGRAPH_TS_TYPECHECKER=0 removes the pass entirely — the call stays unresolved", () => {
    writeCallResultConstFixture(repoRoot);
    const previous = process.env.CODEGRAPH_TS_TYPECHECKER;
    process.env.CODEGRAPH_TS_TYPECHECKER = "0";
    try {
      const resolver = new TSCallResolver(tsOptions, DEFAULT_AMBIGUOUS_RESOLVE_MODE, repoRoot);
      expect(
        resolver.resolve(
          CALL_RESULT_CONST_CALL,
          ctxFor("src/action-modal.ts", callResultConstTable(), "./localization-helper.js"),
        ),
      ).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.CODEGRAPH_TS_TYPECHECKER;
      else process.env.CODEGRAPH_TS_TYPECHECKER = previous;
    }
  });
});
