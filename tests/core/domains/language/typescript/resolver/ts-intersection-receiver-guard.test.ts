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

const sym = (symbolId: string, shortName: string, relPath: string, scope: string[]): NamedSymbol => ({
  symbolId,
  fqName: symbolId,
  shortName,
  relPath,
  scope,
});

/** One project `write`, which is what makes `globalShortName` confident enough to fabricate. */
const collidingTable = (): InMemoryGlobalSymbolTable => {
  const table = new InMemoryGlobalSymbolTable();
  table.upsertFile("src/report-store.ts", [sym("ReportStore#write", "write", "src/report-store.ts", ["ReportStore"])]);
  return table;
};

const PROJECT_WRITE = { targetRelPath: "src/report-store.ts", targetSymbolId: "ReportStore#write" };

const ctx = (callerFile: string, over: Partial<CallContext> = {}): CallContext => ({
  callerFile,
  callerScope: [],
  imports: [{ importText: "dep", startLine: 1, importedNames: ["openWriter"] }],
  symbolTable: collidingTable(),
  ...over,
});

/**
 * The `process.stdout.write(line)` shape, reduced to a fixture the tmp repo can
 * type without `@types/node`: a dependency hands back a value whose type is an
 * INTERSECTION of two of its own interfaces.
 *
 * The receiver is not the imported name — `openWriter` is — so the import arm of
 * the guard never sees it, and the walker binds no type to a `const` initialised
 * from a call. The type checker is the only thing that can answer, and until bd
 * tea-rags-mcp-6o7bi it answered "no evidence": `ts.Type#getSymbol()` on an
 * intersection is `undefined`, so `typeDeclaredOutsideProject` bailed on the
 * first constituent it never looked at.
 */
function writeExternalIntersectionFixture(repoRoot: string): void {
  writeSource(
    repoRoot,
    "node_modules/dep/index.d.ts",
    [
      `export interface Writer {`,
      `  write(chunk: string): boolean;`,
      `}`,
      `export interface Tagged {`,
      `  readonly fd: number;`,
      `}`,
      `export declare function openWriter(): Writer & Tagged;`,
      ``,
    ].join("\n"),
  );
  writeSource(
    repoRoot,
    "src/report.ts",
    [
      `import { openWriter } from "dep";`,
      ``,
      `export function emit(line: string): void {`,
      `  const out = openWriter();`,
      `  out.write(line);`,
      `}`,
      ``,
    ].join("\n"),
  );
}

const EXTERNAL_INTERSECTION_WRITE: CallRef = {
  callText: "out.write(line)",
  receiver: "out",
  member: "write",
  startLine: 5,
};

/**
 * The recall guard: the SAME intersection shape, except one constituent is a
 * project interface. The value reaches project code on this call, so the edge
 * must survive.
 */
function writeMixedIntersectionFixture(repoRoot: string): void {
  writeSource(
    repoRoot,
    "node_modules/dep/index.d.ts",
    [
      `export interface Tagged {`,
      `  readonly fd: number;`,
      `}`,
      ``,
    ].join("\n"),
  );
  writeSource(
    repoRoot,
    "src/report-store.ts",
    [
      `export interface ReportStore {`,
      `  write(chunk: string): boolean;`,
      `}`,
      ``,
    ].join("\n"),
  );
  writeSource(
    repoRoot,
    "src/report.ts",
    [
      `import { Tagged } from "dep";`,
      `import { ReportStore } from "./report-store.js";`,
      ``,
      `export function emit(out: ReportStore & Tagged, line: string): void {`,
      `  out.write(line);`,
      `}`,
      ``,
    ].join("\n"),
  );
}

const MIXED_INTERSECTION_WRITE: CallRef = {
  callText: "out.write(line)",
  receiver: "out",
  member: "write",
  startLine: 5,
};

/**
 * bd tea-rags-mcp-6o7bi — denominator honesty for an INTERSECTION receiver.
 *
 * `typeDeclaredOutsideProject` walked union constituents and nothing else, so
 * `WriteStream & { fd: 1 }` — the type of `process.stdout`, and the shape every
 * branded or augmented dependency value takes — produced no symbol and therefore
 * no verdict. The call then reached `globalShortName`, matched the bare member
 * against the whole symbol table, and stayed in the `resolveSuccessRate`
 * denominator as an internal miss it could never have been.
 *
 * The widening is the same evidence the union arm demands, asked of one more
 * constituent shape: EVERY part of the intersection declared outside the
 * project's own sources. One in-project part still sinks the verdict, because
 * the value carries that part's members too.
 */
describe("intersection receiver — external verdict and denominator (bd tea-rags-mcp-6o7bi)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-intersection-guard-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const strategy = (): TSGlobalShortNameSymbolResolutionStrategy =>
    new TSGlobalShortNameSymbolResolutionStrategy(cfg, new TSProgramCache({ repoRoot, tsOptions }));

  it("continues rather than fabricating an edge onto the single project `write`", () => {
    writeExternalIntersectionFixture(repoRoot);
    expect(strategy().attempt(EXTERNAL_INTERSECTION_WRITE, ctx("src/report.ts")).kind).toBe("continue");
  });

  it("counts the call external so it leaves the resolveSuccessRate denominator", () => {
    writeExternalIntersectionFixture(repoRoot);
    const resolver = new TSCallResolver(tsOptions, DEFAULT_AMBIGUOUS_RESOLVE_MODE, repoRoot);
    expect(resolver.targetsExternalImport(EXTERNAL_INTERSECTION_WRITE, ctx("src/report.ts"))).toBe(true);
  });

  it("emits no edge for it through the whole chain", () => {
    writeExternalIntersectionFixture(repoRoot);
    const resolver = new TSCallResolver(tsOptions, DEFAULT_AMBIGUOUS_RESOLVE_MODE, repoRoot);
    expect(resolver.resolve(EXTERNAL_INTERSECTION_WRITE, ctx("src/report.ts"))).toBeNull();
  });

  it("STILL resolves when one intersection constituent is a PROJECT type", () => {
    writeMixedIntersectionFixture(repoRoot);
    expect(
      strategy().attempt(
        MIXED_INTERSECTION_WRITE,
        ctx("src/report.ts", {
          imports: [
            { importText: "dep", startLine: 1, importedNames: ["Tagged"] },
            { importText: "./report-store.js", startLine: 2, importedNames: ["ReportStore"] },
          ],
        }),
      ),
    ).toEqual({ kind: "resolved", target: PROJECT_WRITE });
  });

  it("keeps that mixed intersection OUT of the external bucket — it is an honest internal call", () => {
    writeMixedIntersectionFixture(repoRoot);
    const resolver = new TSCallResolver(tsOptions, DEFAULT_AMBIGUOUS_RESOLVE_MODE, repoRoot);
    expect(
      resolver.targetsExternalImport(
        MIXED_INTERSECTION_WRITE,
        ctx("src/report.ts", {
          imports: [
            { importText: "dep", startLine: 1, importedNames: ["Tagged"] },
            { importText: "./report-store.js", startLine: 2, importedNames: ["ReportStore"] },
          ],
        }),
      ),
    ).toBe(false);
  });
});
