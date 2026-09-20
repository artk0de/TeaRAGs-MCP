import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CallContext, CallRef } from "../../../../../../../src/core/contracts/types/codegraph.js";
import {
  composeSymbolId,
  TSTypeCheckerFallbackSymbolResolutionStrategy,
} from "../../../../../../../src/core/domains/language/typescript/resolver/strategies/ts-type-checker-fallback.js";
import { TSProgramCache } from "../../../../../../../src/core/domains/language/typescript/resolver/ts-program-cache.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

// ── composeSymbolId: declaration shapes with no other route in ───────

function parse(code: string): ts.SourceFile {
  return ts.createSourceFile("fixture.ts", code, ts.ScriptTarget.Latest, true);
}

function firstNodeMatching(sourceFile: ts.SourceFile, predicate: (node: ts.Node) => boolean): ts.Node {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (found !== undefined) return;
    if (predicate(node)) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  if (found === undefined) throw new Error("No node matched");
  return found;
}

describe("composeSymbolId — declaration shapes", () => {
  // The walker emits a synthetic `constructor` symbol for classes without an
  // explicit one; the checker's constructor declaration must compose to the
  // same name, or `new Repo()` edges would pin to nothing.
  it("names a constructor declaration 'constructor' under the owning class", () => {
    const sourceFile = parse(`class Repo {\n  constructor(readonly id: string) {}\n}\n`);
    const ctor = firstNodeMatching(sourceFile, ts.isConstructorDeclaration);

    expect(composeSymbolId(ctor)).toEqual({ symbolId: "Repo#constructor", shortName: "constructor" });
  });

  // An anonymous class expression has no owner name — the composed id degrades
  // to the bare member name rather than inventing an owner.
  it("falls back to the bare member name when the owner is an anonymous class expression", () => {
    const sourceFile = parse(`export const Factory = class {\n  build(): number {\n    return 1;\n  }\n};\n`);
    const method = firstNodeMatching(sourceFile, ts.isMethodDeclaration);

    expect(composeSymbolId(method)).toEqual({ symbolId: "build", shortName: "build" });
  });
});

// ── JSDoc-signature declarations (JavaScript sources in the Program) ──

/**
 * The checker hands back a JSDocSignature for a JavaScript function whose
 * parameter types come from `@param` tags. A JSDocSignature carries no
 * composable name, so the call degrades to a file-only edge — the file is
 * still certain, the member is not.
 */
describe("TSTypeCheckerFallbackSymbolResolutionStrategy — JSDoc-typed JavaScript declarations", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-typechecker-jsdoc-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("degrades a call into a JSDoc-typed JavaScript file to a file-only edge", () => {
    const writeSource = (relPath: string, content: string): void => {
      const abs = join(repoRoot, relPath);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, "utf8");
    };
    writeSource(
      "src/legacy.js",
      [
        `/** @overload`,
        ` * @param {string} raw the raw text payload`,
        ` * @returns {string} trimmed text`,
        ` */`,
        `/** @overload`,
        ` * @param {{ raw: string }} bag a bag carrying the payload`,
        ` * @returns {string} trimmed text`,
        ` */`,
        `export function parseLegacy(raw) {`,
        `  return typeof raw === "string" ? raw.trim() : raw.raw.trim();`,
        `}`,
        ``,
        `export const legacy = { parse: parseLegacy };`,
        ``,
      ].join("\n"),
    );
    writeSource(
      "src/caller.ts",
      [
        `import { legacy } from "./legacy.js";`,
        ``,
        `export function run(raw: string): string {`,
        `  return legacy.parse(raw);`,
        `}`,
        ``,
      ].join("\n"),
    );

    const tsOptions = { baseUrl: ".", paths: {} };
    const strategy = new TSTypeCheckerFallbackSymbolResolutionStrategy(
      { tsOptions, mode: "strict" },
      new TSProgramCache({ repoRoot, tsOptions }),
    );
    const call: CallRef = { callText: "legacy.parse(raw)", receiver: "legacy", member: "parse", startLine: 4 };
    const ctx: CallContext = {
      callerFile: "src/caller.ts",
      callerScope: [],
      imports: [{ importText: "./legacy.js", startLine: 1, importedNames: ["legacy"] }],
      symbolTable: new InMemoryGlobalSymbolTable(),
    };

    const outcome = strategy.attempt(call, ctx);

    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/legacy.js", targetSymbolId: null },
    });
  });
});
