import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  CallContext,
  CallRef,
  InheritanceEdgeRow,
  InheritanceKind,
  SymbolDefinition,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import { TSProgramCache } from "../../../../../../src/core/domains/language/typescript/resolver/ts-program-cache.js";
import { memberCandidateLacksReceiverEvidence } from "../../../../../../src/core/domains/language/typescript/resolver/ts-receiver-member-evidence.js";
import { MapHierarchyView } from "../../../../../../src/core/domains/trajectory/codegraph/hierarchy-view.js";
import { buildHierarchySnapshot } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/inheritance-edges.js";
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

/** The run-global hierarchy, built the way the provider builds it at the pass-1 barrier. */
const hierarchyOf = (edges: [source: string, ancestor: string, kind: InheritanceKind][]): MapHierarchyView => {
  const rows: InheritanceEdgeRow[] = edges.map(([sourceFqName, ancestorFqName, kind], ordinal) => ({
    sourceFqName,
    sourceSymbolId: null,
    ancestorFqName,
    ancestorSymbolId: null,
    kind,
    ordinal,
  }));
  return new MapHierarchyView(buildHierarchySnapshot(rows));
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

    // Lines mean nothing across the pair, so an OWNERLESS declaration there is
    // matched top level to top level: `export declare function makeLegacy()`
    // speaks for the `.js` file's own `makeLegacy`, never for a class member.
    const NS_CALL: CallRef = { callText: "L.makeLegacy()", receiver: "L", member: "makeLegacy", startLine: 3 };
    const nsCtx = (candidate: SymbolDefinition): CallContext => ({
      callerFile: "src/legacy-ns-caller.ts",
      callerScope: ["cFiveB"],
      imports: [{ importText: "./legacy.js", startLine: 1, importedNames: ["L"] }],
      symbolTable: tableOf(candidate),
    });
    function writeNamespaceCaller(): void {
      writeSource(repoRoot, "src/legacy-ns-caller.ts", [
        'import * as L from "./legacy.js";',
        "export function cFiveB(): number {",
        "  return L.makeLegacy().pingLegacy();",
        "}",
      ]);
    }

    it("lets a top-level declaration in the `.d.ts` account for the `.js` file's top-level function", () => {
      writeLegacyFixture();
      writeNamespaceCaller();
      const make = def("makeLegacy", "makeLegacy", "src/legacy.js", [], [6, 8]);
      expect(lacks(NS_CALL, nsCtx(make), make)).toBe(false);
    });

    it("does not let it account for a class member of that name in the `.js` file", () => {
      writeLegacyFixture();
      writeNamespaceCaller();
      const member = def("Legacy#makeLegacy", "makeLegacy", "src/legacy.js", ["Legacy"], [2, 4]);
      expect(lacks(NS_CALL, nsCtx(member), member)).toBe(true);
    });
  });

  describe("the declaring FILE is not the declaring OWNER", () => {
    function writeUiFixture(): void {
      writeSource(repoRoot, "src/ui.ts", [
        "export type Ev = {",
        "  stopItNow(): void;",
        "};",
        "export class Panel {",
        "  stopItNow(): void {",
        "    return;",
        "  }",
        "}",
        "export class Engine {",
        "  start(): number {",
        "    return 1;",
        "  }",
        "}",
        "export class Timer {",
        "  start(): number {",
        "    return 2;",
        "  }",
        "}",
        "export const svc = {",
        "  runJobNow(): number {",
        "    return 1;",
        "  },",
        "};",
      ]);
      writeSource(repoRoot, "src/ui-caller.ts", [
        'import { Engine, svc, type Ev } from "./ui.js";',
        "function mkEv(): Ev {",
        "  return { stopItNow: () => undefined };",
        "}",
        "function mkEngine(): Engine {",
        "  return new Engine();",
        "}",
        "export function caller(): number {",
        "  const e = mkEv();",
        "  e.stopItNow();",
        "  const engine = mkEngine();",
        "  const s = svc;",
        "  return engine.start() + s.runJobNow();",
        "}",
      ]);
    }

    const PANEL_STOP = def("Panel#stopItNow", "stopItNow", "src/ui.ts", ["Panel"], [5, 7]);
    const ENGINE_START = def("Engine#start", "start", "src/ui.ts", ["Engine"], [10, 12]);
    const TIMER_START = def("Timer#start", "start", "src/ui.ts", ["Timer"], [15, 17]);
    const SVC_RUN = def("svc.runJobNow", "runJobNow", "src/ui.ts", ["svc"], [20, 22]);

    const callerCtx = (): CallContext => ({
      callerFile: "src/ui-caller.ts",
      callerScope: ["caller"],
      imports: [
        {
          importText: "./ui.js",
          startLine: 1,
          importedNames: ["Engine", "svc"],
          importedBindings: { Engine: "Engine", svc: "svc" },
        },
      ],
      symbolTable: tableOf(PANEL_STOP, ENGINE_START, TIMER_START, SVC_RUN),
    });

    const STOP: CallRef = { callText: "e.stopItNow()", receiver: "e", member: "stopItNow", startLine: 10 };
    const START: CallRef = { callText: "engine.start()", receiver: "engine", member: "start", startLine: 13 };
    const RUN: CallRef = { callText: "s.runJobNow()", receiver: "s", member: "runJobNow", startLine: 13 };

    it("declines a class member for a receiver the checker types by a type literal in the same file (probe C12)", () => {
      writeUiFixture();
      expect(lacks(STOP, callerCtx(), PANEL_STOP)).toBe(true);
    });

    it("declines a same-file class that is not the member's declaring class", () => {
      writeUiFixture();
      expect(lacks(START, callerCtx(), TIMER_START)).toBe(true);
    });

    it("accepts the declaring class's own member", () => {
      writeUiFixture();
      expect(lacks(START, callerCtx(), ENGINE_START)).toBe(false);
    });

    it("accepts an object-literal member whose line range contains the declaration", () => {
      writeUiFixture();
      expect(lacks(RUN, callerCtx(), SVC_RUN)).toBe(false);
    });

    it("declines an unnamed declaration when the candidate carries no line range to contain it", () => {
      writeUiFixture();
      const { startLine: _start, endLine: _end, ...unlined } = SVC_RUN;
      expect(lacks(RUN, callerCtx(), unlined)).toBe(true);
    });
  });

  describe("a supertype member the candidate's owner descends from (the hwwtw implementer rule)", () => {
    function writeShapeFixture(): void {
      writeSource(repoRoot, "src/shape.ts", ["export interface Shape {", "  areaOfShape(): number;", "}"]);
      writeSource(repoRoot, "src/circle.ts", [
        'import type { Shape } from "./shape.js";',
        "export class Circle implements Shape {",
        "  areaOfShape(): number {",
        "    return 3;",
        "  }",
        "}",
      ]);
      writeSource(repoRoot, "src/base-job.ts", [
        "export abstract class BaseJob {",
        "  abstract performJobNow(): number;",
        "}",
      ]);
      writeSource(repoRoot, "src/real-job.ts", [
        'import { BaseJob } from "./base-job.js";',
        "export class RealJob extends BaseJob {",
        "  performJobNow(): number {",
        "    return 1;",
        "  }",
        "}",
      ]);
      writeSource(repoRoot, "src/shape-caller.ts", [
        'import { Circle } from "./circle.js";',
        'import { RealJob } from "./real-job.js";',
        'import type { BaseJob } from "./base-job.js";',
        'import type { Shape } from "./shape.js";',
        "function makeShape(): Shape {",
        "  return new Circle();",
        "}",
        "function makeJob(): BaseJob {",
        "  return new RealJob();",
        "}",
        "export function cThree(): number {",
        "  const s = makeShape();",
        "  const j = makeJob();",
        "  return s.areaOfShape() + j.performJobNow();",
        "}",
      ]);
    }

    const CIRCLE_AREA = def("Circle#areaOfShape", "areaOfShape", "src/circle.ts", ["Circle"], [3, 5]);
    const REAL_PERFORM = def("RealJob#performJobNow", "performJobNow", "src/real-job.ts", ["RealJob"], [3, 5]);
    const AREA: CallRef = { callText: "s.areaOfShape()", receiver: "s", member: "areaOfShape", startLine: 14 };
    const PERFORM: CallRef = { callText: "j.performJobNow()", receiver: "j", member: "performJobNow", startLine: 14 };

    const callerCtx = (hierarchy: [source: string, ancestor: string, kind: InheritanceKind][]): CallContext => ({
      callerFile: "src/shape-caller.ts",
      callerScope: ["cThree"],
      imports: [
        { importText: "./circle.js", startLine: 1, importedNames: ["Circle"], importedBindings: { Circle: "Circle" } },
        {
          importText: "./real-job.js",
          startLine: 2,
          importedNames: ["RealJob"],
          importedBindings: { RealJob: "RealJob" },
        },
      ],
      symbolTable: tableOf(CIRCLE_AREA, REAL_PERFORM),
      hierarchy: hierarchyOf(hierarchy),
    });

    it("accepts an implementer the run hierarchy records for the declaring interface", () => {
      writeShapeFixture();
      expect(lacks(AREA, callerCtx([["Circle", "Shape", "implements"]]), CIRCLE_AREA)).toBe(false);
    });

    it("accepts a subclass of the abstract base that declares the member", () => {
      writeShapeFixture();
      expect(lacks(PERFORM, callerCtx([["RealJob", "BaseJob", "super"]]), REAL_PERFORM)).toBe(false);
    });

    it("declines a class the hierarchy does not connect to the declaring interface", () => {
      writeShapeFixture();
      expect(lacks(AREA, callerCtx([]), CIRCLE_AREA)).toBe(true);
    });
  });
});
