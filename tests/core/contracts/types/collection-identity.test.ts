/**
 * The collection-identity brands are enforced by the COMPILER (bd tea-rags-mcp-39xca.1).
 *
 * `npm run type-check` covers `src/` only, and vitest strips types without
 * checking them, so a type-level guarantee needs its own compile step. This
 * builds a TypeScript program over two fixtures with the repository's compiler
 * options:
 *
 * - `collection-identity-boundaries.ts` must type-check cleanly. Every
 *   `@ts-expect-error` in it is a call a storage boundary must reject; widen one
 *   boundary back to `string` and its directive becomes TS2578, failing here.
 * - `collection-identity-violation.ts` must report exactly one TS2322, proving
 *   the compile step still reports type errors at all.
 */

import { join } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const FIXTURES = join(import.meta.dirname, "__fixtures__");

/** Pre-emit diagnostics for one file, compiled with the repo's `tsconfig.json` options. */
function typeCheck(file: string): { code: number; text: string }[] {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    join(REPO_ROOT, "tsconfig.json"),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
      },
    },
  );
  if (!parsed) throw new Error("tsconfig.json could not be parsed");
  const program = ts.createProgram([file], {
    ...parsed.options,
    rootDir: REPO_ROOT,
    noEmit: true,
    declaration: false,
    declarationMap: false,
    sourceMap: false,
  });
  return ts.getPreEmitDiagnostics(program).map((diagnostic) => {
    const where =
      diagnostic.file && diagnostic.start !== undefined
        ? `${diagnostic.file.fileName}:${diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1}`
        : "<global>";
    return { code: diagnostic.code, text: `${where} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}` };
  });
}

describe("collection identity brands (39xca.1)", () => {
  it("every storage boundary rejects an unresolved name and an alias where a physical name is required", () => {
    expect(typeCheck(join(FIXTURES, "collection-identity-boundaries.ts")).map((d) => d.text)).toEqual([]);
  }, 120_000);

  it("the compile step reports a string literal typed as a physical name", () => {
    expect(typeCheck(join(FIXTURES, "collection-identity-violation.ts")).map((d) => d.code)).toEqual([2322]);
  }, 120_000);
});
