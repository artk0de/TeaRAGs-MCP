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

/** A dependency with a `types` entry, so the compiler resolves the bare specifier. */
function writePackage(repoRoot: string, name: string, declaration: string): void {
  writeSource(
    repoRoot,
    `node_modules/${name}/package.json`,
    JSON.stringify({ name, version: "1.0.0", types: "index.d.ts" }),
  );
  writeSource(repoRoot, `node_modules/${name}/index.d.ts`, declaration);
}

const sym = (symbolId: string, shortName: string, relPath: string, scope: string[]): NamedSymbol => ({
  symbolId,
  fqName: symbolId,
  shortName,
  relPath,
  scope,
});

/** One project symbol per colliding short name — what makes `globalShortName` fabricate. */
const collidingTable = (): InMemoryGlobalSymbolTable => {
  const table = new InMemoryGlobalSymbolTable();
  table.upsertFile("src/legacy.ts", [sym("LegacyText#sanitize", "sanitize", "src/legacy.ts", ["LegacyText"])]);
  table.upsertFile("src/bus.ts", [sym("Bus#emit", "emit", "src/bus.ts", ["Bus"])]);
  return table;
};

const ctx = (callerFile: string, importText: string, importedNames: string[]): CallContext => ({
  callerFile,
  callerScope: [],
  imports: [{ importText, startLine: 1, importedNames }],
  symbolTable: collidingTable(),
});

/**
 * The taxdome shape, reduced: a project module destructures a callable off a
 * dependency's default export and re-exports it, and callers import it from the
 * project module. `react-app/lib/sanitizeHelper.ts` does exactly this with
 * `dompurify`, and it is the largest single cluster the arm recovers — 24 of the
 * 40 bare calls left in that corpus's denominator with a resolvable signature.
 *
 * Nothing else in the guard can speak. The import maps INTO the project, so the
 * specifier arm is silent; the callee is an `ImportSpecifier`, not a local value
 * binding, so the bare-callee arm is silent; there is no receiver at all, so
 * every receiver arm returns before it starts. The checker names the
 * declaration outright.
 */
function writeReExportedDependencyCalleeFixture(repoRoot: string): void {
  writePackage(
    repoRoot,
    "purify-pkg",
    [
      `export interface Purifier {`,
      `  sanitize(html: string): string;`,
      `}`,
      `declare const purifier: Purifier;`,
      `export default purifier;`,
      ``,
    ].join("\n"),
  );
  writeSource(
    repoRoot,
    "src/sanitize-helper.ts",
    [`import purifier from "purify-pkg";`, ``, `export const { sanitize } = purifier;`, ``].join("\n"),
  );
  writeSource(
    repoRoot,
    "src/render.ts",
    [
      `import { sanitize } from "./sanitize-helper.js";`,
      ``,
      `export function render(html: string): string {`,
      `  return sanitize(html);`,
      `}`,
      ``,
    ].join("\n"),
  );
}

const RE_EXPORTED_SANITIZE: CallRef = {
  callText: "sanitize(html)",
  receiver: null,
  member: "sanitize",
  startLine: 4,
};

/**
 * RECALL GUARD — bd tea-rags-mcp-otm6n's fixture, restated here because this arm
 * is the one that could break it. A project class extending a dependency's has
 * its inherited member DECLARED in `node_modules`, so the resolved signature
 * points outside the project while the call genuinely reaches project code.
 */
function writeExtendsPackageBaseFixture(repoRoot: string): void {
  writePackage(
    repoRoot,
    "emitter-pkg",
    [`export declare class BaseEmitter {`, `  emit(name: string): void;`, `}`, ``].join("\n"),
  );
  writeSource(
    repoRoot,
    "src/bus.ts",
    [
      `import { BaseEmitter } from "emitter-pkg";`,
      ``,
      `export class Bus extends BaseEmitter {}`,
      ``,
      `export function makeBus(): Bus {`,
      `  return new Bus();`,
      `}`,
      ``,
    ].join("\n"),
  );
  writeSource(
    repoRoot,
    "src/bus-caller.ts",
    [
      `import { makeBus } from "./bus.js";`,
      ``,
      `export function run(): void {`,
      `  const bus = makeBus();`,
      `  bus.emit("ready");`,
      `}`,
      ``,
    ].join("\n"),
  );
}

const PROJECT_SUBCLASS_EMIT: CallRef = {
  callText: 'bus.emit("ready")',
  receiver: "bus",
  member: "emit",
  startLine: 5,
};

/**
 * bd tea-rags-mcp-6o7bi — the one arm of `targetsExternalImport` that asks about
 * the CALLEE rather than the receiver.
 *
 * `typeCheckerFallback` (pass 12) already resolves the signature and already
 * reads its declaration's file; it simply CONTINUEs when the declaration is not
 * a project source, discarding a proof it holds. The call then reached pass 9,
 * matched its bare member against the whole symbol table, and stayed in the
 * `resolveSuccessRate` denominator as an internal miss nothing could have
 * resolved.
 *
 * The arm is narrowed to receivers that name NO project declaration, which is
 * what keeps bd tea-rags-mcp-otm6n's recall guard intact rather than trading it
 * away for the metric.
 */
describe("resolved-signature callee guard (bd tea-rags-mcp-6o7bi)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-resolved-signature-guard-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const strategy = (): TSGlobalShortNameSymbolResolutionStrategy =>
    new TSGlobalShortNameSymbolResolutionStrategy(cfg, new TSProgramCache({ repoRoot, tsOptions }));

  const reExportCtx = (): CallContext => ctx("src/render.ts", "./sanitize-helper.js", ["sanitize"]);
  const subclassCtx = (): CallContext => ctx("src/bus-caller.ts", "./bus.js", ["makeBus"]);

  it("continues rather than matching a re-exported dependency callee onto a project `sanitize`", () => {
    writeReExportedDependencyCalleeFixture(repoRoot);
    expect(strategy().attempt(RE_EXPORTED_SANITIZE, reExportCtx()).kind).toBe("continue");
  });

  it("counts that call external so it leaves the resolveSuccessRate denominator", () => {
    writeReExportedDependencyCalleeFixture(repoRoot);
    const resolver = new TSCallResolver(tsOptions, DEFAULT_AMBIGUOUS_RESOLVE_MODE, repoRoot);
    expect(resolver.targetsExternalImport(RE_EXPORTED_SANITIZE, reExportCtx())).toBe(true);
  });

  it("STILL resolves for a project class extending a package base class (the otm6n recall guard)", () => {
    writeExtendsPackageBaseFixture(repoRoot);
    expect(strategy().attempt(PROJECT_SUBCLASS_EMIT, subclassCtx())).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/bus.ts", targetSymbolId: "Bus#emit" },
    });
  });

  it("keeps that inherited call OUT of the external bucket — its receiver is the project's", () => {
    writeExtendsPackageBaseFixture(repoRoot);
    const resolver = new TSCallResolver(tsOptions, DEFAULT_AMBIGUOUS_RESOLVE_MODE, repoRoot);
    expect(resolver.targetsExternalImport(PROJECT_SUBCLASS_EMIT, subclassCtx())).toBe(false);
  });

  it("says nothing when the member has NO in-project definition — that call is already excluded", () => {
    writeReExportedDependencyCalleeFixture(repoRoot);
    const resolver = new TSCallResolver(tsOptions, DEFAULT_AMBIGUOUS_RESOLVE_MODE, repoRoot);
    expect(
      resolver.targetsExternalImport(RE_EXPORTED_SANITIZE, {
        ...reExportCtx(),
        symbolTable: new InMemoryGlobalSymbolTable(),
      }),
    ).toBe(false);
  });

  it("CODEGRAPH_TS_TYPECHECKER=0 leaves the guard exactly as it was", () => {
    writeReExportedDependencyCalleeFixture(repoRoot);
    const previous = process.env.CODEGRAPH_TS_TYPECHECKER;
    process.env.CODEGRAPH_TS_TYPECHECKER = "0";
    try {
      const resolver = new TSCallResolver(tsOptions, DEFAULT_AMBIGUOUS_RESOLVE_MODE, repoRoot);
      expect(resolver.targetsExternalImport(RE_EXPORTED_SANITIZE, reExportCtx())).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.CODEGRAPH_TS_TYPECHECKER;
      else process.env.CODEGRAPH_TS_TYPECHECKER = previous;
    }
  });
});
