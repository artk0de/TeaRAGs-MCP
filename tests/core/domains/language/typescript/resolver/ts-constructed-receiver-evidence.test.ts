import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type CallRef,
  type ImportRef,
  type InheritanceEdgeRow,
  type InheritanceKind,
  type SymbolDefinition,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import {
  TSGlobalShortNameSymbolResolutionStrategy,
  type ResolverConfig,
} from "../../../../../../src/core/domains/language/typescript/resolver/strategies/index.js";
import { MapHierarchyView } from "../../../../../../src/core/domains/trajectory/codegraph/hierarchy-view.js";
import { buildHierarchySnapshot } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/inheritance-edges.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const tsOptions = { baseUrl: ".", paths: {} };
const cfg: ResolverConfig = { tsOptions, mode: DEFAULT_AMBIGUOUS_RESOLVE_MODE };

function writeSource(repoRoot: string, relPath: string, lines: string[]): void {
  const abs = join(repoRoot, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `${lines.join("\n")}\n`, "utf8");
}

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
 * A receiver that CONSTRUCTS or produces its type — `new ImportedClass().m()`
 * and `createX().m()` (bd tea-rags-mcp-pv7ul). The walker emits the receiver
 * text verbatim (`"new Gadget()"`, `"createGadget()"`), which binds no import
 * and sits in no class, so the t5cji guard declines every candidate and the
 * checker-off mode loses the site. `new X()` for an import binding to a
 * project class is evidence as strong as a typed receiver — the candidate must
 * be owned by X (or a file-anchored ancestor), never a bare same-file
 * namesake; the same ownership rule through the type a `createX()` factory's
 * name embeds, with the factory anchored as a project callable first.
 *
 * Every test here runs the checker-OFF path (`programCache: null`) — that is
 * the mode the 26 recovered self-index sites live in.
 */
describe("memberCandidateLacksReceiverEvidence — a receiver that constructs or produces its type (bd tea-rags-mcp-pv7ul)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-constructed-receiver-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  /** The checker-off chain head the guard sits behind: a unique short-name pick. */
  const resolve = (call: CallRef, ctx: CallContext): "resolved" | "continue" => {
    const outcome = new TSGlobalShortNameSymbolResolutionStrategy(cfg, null).attempt(call, ctx);
    return outcome.kind === "resolved" ? "resolved" : "continue";
  };

  const targetsOf = (call: CallRef, ctx: CallContext): { targetRelPath: string; targetSymbolId: string } | null => {
    const outcome = new TSGlobalShortNameSymbolResolutionStrategy(cfg, null).attempt(call, ctx);
    return outcome.kind === "resolved" ? outcome.target : null;
  };

  const imported = (name: string, importText: string): ImportRef => ({
    importText,
    startLine: 1,
    importedNames: [name],
    importedBindings: { [name]: name },
  });

  const callerCtx = (
    imports: ImportRef[],
    symbolTable: InMemoryGlobalSymbolTable,
    hierarchy?: MapHierarchyView,
  ): CallContext => ({
    callerFile: "src/caller.ts",
    callerScope: ["run"],
    imports,
    symbolTable,
    ...(hierarchy === undefined ? {} : { hierarchy }),
  });

  describe("a `new ImportedClass()` receiver", () => {
    function writeGadgetFixture(): void {
      writeSource(repoRoot, "src/gadget.ts", [
        "export class Gadget {",
        "  ping(): number {",
        "    return 1;",
        "  }",
        "}",
      ]);
      writeSource(repoRoot, "src/caller.ts", [
        'import { Gadget } from "./gadget.js";',
        "export function run(): number {",
        "  return new Gadget().ping();",
        "}",
      ]);
    }

    const CALL: CallRef = { callText: "new Gadget().ping()", receiver: "new Gadget()", member: "ping", startLine: 3 };

    it("resolves the member to the imported class the receiver constructs", () => {
      writeGadgetFixture();
      const table = tableOf(def("Gadget#ping", "ping", "src/gadget.ts", ["Gadget"], [2, 4]));
      expect(targetsOf(CALL, callerCtx([imported("Gadget", "./gadget.js")], table))).toEqual({
        targetRelPath: "src/gadget.ts",
        targetSymbolId: "Gadget#ping",
      });
    });

    it("anchors the class declared in the caller's own file without an import", () => {
      writeSource(repoRoot, "src/caller.ts", [
        "export class Local {",
        "  ping(): number {",
        "    return 1;",
        "  }",
        "}",
        "export function run(): number {",
        "  return new Local().ping();",
        "}",
      ]);
      const table = tableOf(
        def("Local", "Local", "src/caller.ts", [], [1, 5]),
        def("Local#ping", "ping", "src/caller.ts", ["Local"], [2, 4]),
      );
      const localCall: CallRef = {
        callText: "new Local().ping()",
        receiver: "new Local()",
        member: "ping",
        startLine: 7,
      };
      expect(targetsOf(localCall, callerCtx([], table))).toEqual({
        targetRelPath: "src/caller.ts",
        targetSymbolId: "Local#ping",
      });
    });

    it("resolves an inherited member to the file-anchored base the constructed class extends", () => {
      writeSource(repoRoot, "src/gadget.ts", [
        "export class Base {",
        "  ping(): number {",
        "    return 1;",
        "  }",
        "}",
        "export class Gadget extends Base {}",
      ]);
      writeSource(repoRoot, "src/caller.ts", [
        'import { Gadget } from "./gadget.js";',
        "export function run(): number {",
        "  return new Gadget().ping();",
        "}",
      ]);
      const table = tableOf(
        def("Base", "Base", "src/gadget.ts", [], [1, 5]),
        def("Base#ping", "ping", "src/gadget.ts", ["Base"], [2, 4]),
      );
      const hierarchy = hierarchyOf([["Gadget", "Base", "super"]]);
      expect(targetsOf(CALL, callerCtx([imported("Gadget", "./gadget.js")], table, hierarchy))).toEqual({
        targetRelPath: "src/gadget.ts",
        targetSymbolId: "Base#ping",
      });
    });

    it("declines a namesake of the constructed class that the import does not bind", () => {
      // The receiver anchors Gadget to ./gadget.js; a `Gadget#ping` an unrelated
      // file declares is a bare same-file namesake and must stay declined — the
      // pv7ul analogue of the C12 misattribution the owner rule closed.
      writeGadgetFixture();
      writeSource(repoRoot, "src/decoy.ts", [
        "export class Gadget {",
        "  ping(): number {",
        "    return 2;",
        "  }",
        "}",
      ]);
      const table = tableOf(def("Gadget#ping", "ping", "src/decoy.ts", ["Gadget"], [2, 4]));
      expect(resolve(CALL, callerCtx([imported("Gadget", "./gadget.js")], table))).toBe("continue");
    });
  });

  describe("a `createX()` factory-call receiver", () => {
    it("resolves the member through the type the factory's name constructs", () => {
      writeSource(repoRoot, "src/gadget.ts", [
        "export class Gadget {",
        "  ping(): number {",
        "    return 1;",
        "  }",
        "}",
        "export function createGadget(): Gadget {",
        "  return new Gadget();",
        "}",
      ]);
      writeSource(repoRoot, "src/caller.ts", [
        'import { createGadget } from "./gadget.js";',
        "export function run(): number {",
        "  return createGadget().ping();",
        "}",
      ]);
      const call: CallRef = {
        callText: "createGadget().ping()",
        receiver: "createGadget()",
        member: "ping",
        startLine: 3,
      };
      const table = tableOf(
        def("Gadget", "Gadget", "src/gadget.ts", [], [1, 5]),
        def("Gadget#ping", "ping", "src/gadget.ts", ["Gadget"], [2, 4]),
        def("createGadget", "createGadget", "src/gadget.ts", [], [6, 8]),
      );
      expect(targetsOf(call, callerCtx([imported("createGadget", "./gadget.js")], table))).toEqual({
        targetRelPath: "src/gadget.ts",
        targetSymbolId: "Gadget#ping",
      });
    });

    it("declines a factory whose named type declares no such member — never the same-file free function", () => {
      // `createThing()` returns an object literal; the lone `check` in its file
      // is a FREE FUNCTION. Accepting it would be the hwwtw misattribution this
      // evidence class exists to avoid.
      writeSource(repoRoot, "src/thing.ts", [
        "export function createThing(): { other(): void } {",
        "  return { other() {} };",
        "}",
        "export function check(): number {",
        "  return 1;",
        "}",
      ]);
      writeSource(repoRoot, "src/caller.ts", [
        'import { createThing } from "./thing.js";',
        "export function run(): void {",
        "  createThing().check();",
        "}",
      ]);
      const call: CallRef = {
        callText: "createThing().check()",
        receiver: "createThing()",
        member: "check",
        startLine: 3,
      };
      const table = tableOf(
        def("createThing", "createThing", "src/thing.ts", [], [1, 3]),
        def("check", "check", "src/thing.ts", [], [4, 6]),
      );
      expect(resolve(call, callerCtx([imported("createThing", "./thing.js")], table))).toBe("continue");
    });

    it("declines a callee that is not a create-prefixed type name — the shape carries no type", () => {
      writeGadgetFixtureLikeFactory("resetStore");
      const call: CallRef = { callText: "resetStore().ping()", receiver: "resetStore()", member: "ping", startLine: 3 };
      const table = tableOf(
        def("Gadget#ping", "ping", "src/gadget.ts", ["Gadget"], [2, 4]),
        def("resetStore", "resetStore", "src/gadget.ts", [], [6, 8]),
      );
      expect(resolve(call, callerCtx([imported("resetStore", "./gadget.js")], table))).toBe("continue");
    });

    function writeGadgetFixtureLikeFactory(factoryName: string): void {
      writeSource(repoRoot, "src/gadget.ts", [
        "export class Gadget {",
        "  ping(): number {",
        "    return 1;",
        "  }",
        "}",
        `export function ${factoryName}(): Gadget {`,
        "  return new Gadget();",
        "}",
      ]);
      writeSource(repoRoot, "src/caller.ts", [
        `import { ${factoryName} } from "./gadget.js";`,
        "export function run(): number {",
        `  return ${factoryName}().ping();`,
        "}",
      ]);
    }
  });

  describe("the C12 misattribution the owner rule closed (bd tea-rags-mcp-nj8i6)", () => {
    it("keeps a type-literal receiver's member off the unrelated same-file class — file-only, never committed", () => {
      // The pv7ul evidence class must not reopen C12: receiver "e" constructs
      // and produces nothing — it binds no import and names no type — so the
      // guard's verdict on `Panel#stopItNow` must stay LACKS EVIDENCE.
      writeSource(repoRoot, "src/caller.ts", [
        "type PanelEvent = {",
        "  stopItNow(): void;",
        "};",
        "",
        "export function makeEvent(): PanelEvent {",
        "  return { stopItNow() {} };",
        "}",
        "",
        "export function run(): void {",
        "  const e = makeEvent();",
        "  e.stopItNow();",
        "}",
        "",
        "export class Panel {",
        "  stopItNow(): void {}",
        "}",
      ]);
      const call: CallRef = { callText: "e.stopItNow()", receiver: "e", member: "stopItNow", startLine: 11 };
      const table = tableOf(def("Panel#stopItNow", "stopItNow", "src/caller.ts", ["Panel"], [15, 15]));
      expect(resolve(call, callerCtx([], table))).toBe("continue");
    });
  });
});
