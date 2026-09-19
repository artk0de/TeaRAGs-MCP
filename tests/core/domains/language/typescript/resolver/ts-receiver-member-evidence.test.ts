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

  describe("a declaration file beside the JavaScript it types", () => {
    // The checker reads `legacy.d.ts`, the codegraph walks `legacy.js`: the
    // member is declared in the one and implemented, as a symbol, in the other.
    const PING = def("Legacy#pingLegacy", "pingLegacy", "src/legacy.js", ["Legacy"], [2, 4]);

    function writeLegacyFixture(): void {
      writeSource(repoRoot, "src/legacy.js", [
        "export class Legacy {",
        "  pingLegacy() {",
        "    return 1;",
        "  }",
        "}",
        "export function makeLegacy() {",
        "  return new Legacy();",
        "}",
      ]);
      writeSource(repoRoot, "src/legacy.d.ts", [
        "export declare class Legacy {",
        "  pingLegacy(): number;",
        "}",
        "export declare function makeLegacy(): Legacy;",
      ]);
      writeSource(repoRoot, "src/legacy-caller.ts", [
        'import { makeLegacy } from "./legacy.js";',
        "export function cFive(): number {",
        "  const l = makeLegacy();",
        "  return l.pingLegacy();",
        "}",
      ]);
    }

    const CALL: CallRef = { callText: "l.pingLegacy()", receiver: "l", member: "pingLegacy", startLine: 4 };
    const callerCtx = (candidate: SymbolDefinition): CallContext => ({
      callerFile: "src/legacy-caller.ts",
      callerScope: ["cFive"],
      imports: [
        {
          importText: "./legacy.js",
          startLine: 1,
          importedNames: ["makeLegacy"],
          importedBindings: { makeLegacy: "makeLegacy" },
        },
      ],
      symbolTable: tableOf(candidate),
    });

    it("lets `<stem>.d.ts` account for the member its sibling `<stem>.js` implements", () => {
      writeLegacyFixture();
      expect(lacks(CALL, callerCtx(PING), PING)).toBe(false);
    });

    it("does not let it account for a JavaScript file of another stem", () => {
      writeLegacyFixture();
      const elsewhere = def("Legacy#pingLegacy", "pingLegacy", "src/other.js", ["Legacy"], [2, 4]);
      expect(lacks(CALL, callerCtx(elsewhere), elsewhere)).toBe(true);
    });
  });
});
