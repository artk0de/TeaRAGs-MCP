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
  type ResolverConfig,
} from "../../../../../../src/core/domains/language/typescript/resolver/strategies/index.js";
import { importBoundProjectFile } from "../../../../../../src/core/domains/language/typescript/resolver/ts-import-bound-callee.js";
import { TSProgramCache } from "../../../../../../src/core/domains/language/typescript/resolver/ts-program-cache.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const tsOptions = { baseUrl: ".", paths: {} };

function writeSource(repoRoot: string, relPath: string, content: string): void {
  const abs = join(repoRoot, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

const sym = (symbolId: string, shortName: string, relPath: string): NamedSymbol => ({
  symbolId,
  fqName: symbolId,
  shortName,
  relPath,
  scope: [],
});

const CALLER = "src/gallery/table/Cell.ts";
const LOCAL_HELPERS = "src/gallery/shared/tableHelpers.ts";
const UNRELATED_HELPERS = "src/app/helpers/getRenderableContent.ts";
const BARREL = "src/app/index.ts";

const CALL: CallRef = {
  callText: "getRenderableContent(column)",
  receiver: null,
  member: "getRenderableContent",
  startLine: 4,
};

/** Only the unrelated helper carries an INDEXED symbol of that name — N === 1. */
const singleCandidateTable = (): InMemoryGlobalSymbolTable => {
  const table = new InMemoryGlobalSymbolTable();
  table.upsertFile(UNRELATED_HELPERS, [sym("getRenderableContent", "getRenderableContent", UNRELATED_HELPERS)]);
  return table;
};

/**
 * The taxdome shape, reduced. The gallery's own `tableHelpers.ts` exports
 * `getRenderableContent = memoize(renderContent)` — a `const` bound to a CALL,
 * which the walker does not name, so the copy contributes no symbol and the one
 * indexed symbol of that name sits in an unrelated helper the caller never
 * imports.
 */
function writeSameNameCoincidenceFixture(repoRoot: string): void {
  writeSource(
    repoRoot,
    LOCAL_HELPERS,
    [
      `function renderContent(column: string): string {`,
      `  return column;`,
      `}`,
      ``,
      `export const getRenderableContent = renderContent;`,
      ``,
    ].join("\n"),
  );
  writeSource(
    repoRoot,
    UNRELATED_HELPERS,
    [`export function getRenderableContent(column: string): string {`, `  return column;`, `}`, ``].join("\n"),
  );
  writeSource(
    repoRoot,
    CALLER,
    [
      `import { getRenderableContent } from "../shared/tableHelpers.js";`,
      ``,
      `export function cell(column: string): string {`,
      `  return getRenderableContent(column);`,
      `}`,
      ``,
    ].join("\n"),
  );
}

/**
 * RECALL GUARD — the shape this repo is built out of. `.claude/rules/barrel-files.md`
 * makes cross-domain imports go through `index.ts`, so the import binds the name
 * to the BARREL while the declaration lives one re-export behind it. Import and
 * index disagree on every one of those calls, and declining them cost 202 missed
 * defects on `src` when the guard read the disagreement alone.
 */
function writeBarrelReexportFixture(repoRoot: string): void {
  writeSource(
    repoRoot,
    UNRELATED_HELPERS,
    [`export function getRenderableContent(column: string): string {`, `  return column;`, `}`, ``].join("\n"),
  );
  writeSource(
    repoRoot,
    BARREL,
    [`export { getRenderableContent } from "./helpers/getRenderableContent.js";`, ``].join("\n"),
  );
  writeSource(
    repoRoot,
    CALLER,
    [
      `import { getRenderableContent } from "../../app/index.js";`,
      ``,
      `export function cell(column: string): string {`,
      `  return getRenderableContent(column);`,
      `}`,
      ``,
    ].join("\n"),
  );
}

/**
 * bd tea-rags-mcp-d0xpr — a bare callee the caller IMPORTED belongs to the file
 * the import names, not to whichever file happens to declare the short name.
 *
 * Strict mode's ambiguity refusal only fires at N>1, and the measured defect is
 * at N=1: 52 `wrongFile` rows across taxdome's prototype galleries, each call
 * pointing at a `react-app` helper the caller does not import.
 *
 * The disagreement alone is not proof — a barrel re-export produces exactly the
 * same disagreement — so the type checker arbitrates, and only there.
 */
describe("globalShortName — the caller's import binds the bare callee (bd tea-rags-mcp-d0xpr)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-import-bound-callee-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const cfg = (): ResolverConfig => ({ tsOptions, mode: DEFAULT_AMBIGUOUS_RESOLVE_MODE });

  const strategy = (withChecker = true): TSGlobalShortNameSymbolResolutionStrategy =>
    new TSGlobalShortNameSymbolResolutionStrategy(
      cfg(),
      withChecker ? new TSProgramCache({ repoRoot, tsOptions }) : null,
    );

  const ctx = (importText: string, over: Partial<CallContext> = {}): CallContext => ({
    callerFile: CALLER,
    callerScope: [],
    imports: [{ importText, startLine: 1, importedNames: ["getRenderableContent"] }],
    symbolTable: singleCandidateTable(),
    ...over,
  });

  it("declines the single candidate when the checker names the file the caller imports", () => {
    writeSameNameCoincidenceFixture(repoRoot);
    expect(strategy().attempt(CALL, ctx("../shared/tableHelpers.js")).kind).toBe("continue");
  });

  it("STILL resolves through a BARREL, where the declaration is one re-export behind the import", () => {
    writeBarrelReexportFixture(repoRoot);
    expect(strategy().attempt(CALL, ctx("../../app/index.js"))).toEqual({
      kind: "resolved",
      target: { targetRelPath: UNRELATED_HELPERS, targetSymbolId: "getRenderableContent" },
    });
  });

  it("STILL resolves when NO import binds the name — the guard has nothing to say", () => {
    writeSameNameCoincidenceFixture(repoRoot);
    expect(
      strategy().attempt(CALL, ctx("./styles.css", { imports: [{ importText: "./styles.css", startLine: 1 }] })),
    ).toEqual({
      kind: "resolved",
      target: { targetRelPath: UNRELATED_HELPERS, targetSymbolId: "getRenderableContent" },
    });
  });

  it("STILL resolves when the checker cannot answer — the disagreement alone is not evidence", () => {
    writeSameNameCoincidenceFixture(repoRoot);
    expect(strategy(false).attempt(CALL, ctx("../shared/tableHelpers.js"))).toEqual({
      kind: "resolved",
      target: { targetRelPath: UNRELATED_HELPERS, targetSymbolId: "getRenderableContent" },
    });
  });

  it("says nothing about a RECEIVER-bearing call — there the import binds the receiver, not the member", () => {
    writeSameNameCoincidenceFixture(repoRoot);
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile(UNRELATED_HELPERS, [sym("Helpers#render", "render", UNRELATED_HELPERS)]);
    const memberCall: CallRef = { callText: "helpers.render(c)", receiver: "helpers", member: "render", startLine: 4 };
    const context = ctx("../shared/tableHelpers.js", {
      symbolTable: table,
      imports: [{ importText: "../shared/tableHelpers.js", startLine: 1, importedNames: ["render"] }],
    });
    expect(importBoundProjectFile(memberCall, context, tsOptions)).toBeNull();
    // The member call itself is no longer committed by name: nothing typed
    // `helpers`, so the pass continues (bd tea-rags-mcp-t5cji).
    expect(strategy().attempt(memberCall, context).kind).toBe("continue");
  });
});
