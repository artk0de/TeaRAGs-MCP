import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CallContext, CallRef, SymbolDefinition } from "../../../../../../src/core/contracts/types/codegraph.js";
import { TSProgramCache } from "../../../../../../src/core/domains/language/typescript/resolver/ts-program-cache.js";
import { memberCandidateLacksReceiverEvidence } from "../../../../../../src/core/domains/language/typescript/resolver/ts-receiver-member-evidence.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const tsOptions = { baseUrl: ".", paths: {} };

function writeSource(repoRoot: string, relPath: string, lines: string[]): void {
  const abs = join(repoRoot, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `${lines.join("\n")}\n`, "utf8");
}

type Candidate = Pick<SymbolDefinition, "relPath" | "scope" | "startLine" | "endLine">;

/** A symbol-table row with the walker's line range, the shape a real run hydrates. */
const def = (
  symbolId: string,
  shortName: string,
  relPath: string,
  scope: string[],
  lines: [number, number],
): SymbolDefinition => ({
  symbolId,
  fqName: symbolId,
  shortName,
  relPath,
  scope,
  startLine: lines[0],
  endLine: lines[1],
});

const tableOf = (...defs: SymbolDefinition[]): InMemoryGlobalSymbolTable => {
  const table = new InMemoryGlobalSymbolTable();
  const byFile = new Map<string, SymbolDefinition[]>();
  for (const d of defs) byFile.set(d.relPath, [...(byFile.get(d.relPath) ?? []), d]);
  for (const [relPath, rows] of byFile) table.upsertFile(relPath, rows);
  return table;
};

/**
 * The evidence guard's own verdicts, asked directly (bd tea-rags-mcp-t5cji). A
 * `true` means the candidate rests on its short name alone and the short-name
 * passes must decline it; `false` means the checker's declaration of the called
 * member accounts for it.
 */
describe("memberCandidateLacksReceiverEvidence — the checker's declaration must account for the candidate (bd tea-rags-mcp-t5cji)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-member-evidence-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const lacks = (call: CallRef, ctx: CallContext, candidate: Candidate): boolean =>
    memberCandidateLacksReceiverEvidence(call, ctx, new TSProgramCache({ repoRoot, tsOptions }), candidate);

  describe("a namespace import through a NAMED re-export barrel", () => {
    // `getSymbolAtLocation` answers the barrel's `ExportSpecifier` — an alias —
    // for `H.fooHelperFn`; its declaration sits in the barrel, not in the file
    // that declares the function, so the correct edge used to be declined.
    const FOO_HELPER = def("fooHelperFn", "fooHelperFn", "src/helpers/foo-helper.ts", [], [1, 3]);

    function writeBarrelFixture(): void {
      writeSource(repoRoot, "src/helpers/foo-helper.ts", [
        "export function fooHelperFn(): number {",
        "  return 1;",
        "}",
      ]);
      writeSource(repoRoot, "src/helpers/index.ts", ['export { fooHelperFn } from "./foo-helper.js";']);
      writeSource(repoRoot, "src/caller.ts", [
        'import * as H from "./helpers/index.js";',
        "export function cOne(): number {",
        "  return H.fooHelperFn();",
        "}",
      ]);
    }

    const CALL: CallRef = { callText: "H.fooHelperFn()", receiver: "H", member: "fooHelperFn", startLine: 3 };
    const callerCtx = (): CallContext => ({
      callerFile: "src/caller.ts",
      callerScope: ["cOne"],
      imports: [{ importText: "./helpers/index.js", startLine: 1, importedNames: ["H"] }],
      symbolTable: tableOf(FOO_HELPER),
    });

    it("follows the alias to the declaring file and accepts the function it re-exports", () => {
      writeBarrelFixture();
      expect(lacks(CALL, callerCtx(), FOO_HELPER)).toBe(false);
    });
  });
});
