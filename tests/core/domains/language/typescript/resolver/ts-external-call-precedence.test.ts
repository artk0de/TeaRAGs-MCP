// targetsExternalImport composes its guards in one fixed order. Each per-guard
// test file pins a single guard's verdict; this corpus pins the ORDER — which
// arm decides when two of them could both answer, and what a program-less run
// (every checker arm dark) leaves alive.
//
// Evaluation order, from ts-external-call.ts:
//
//   A0  ECMASCRIPT_GLOBALS.has(receiver)                      — pure
//   A1  receiver === null && BARE_GLOBAL_CALLABLES.has(member) — pure
//   A2  boundName bound by an import that maps to no project file — pure
//   A3  receiver "super"  → RETURN superBaseDeclaredOutsideProject (final)
//   A4  receiver "this"   → thisMemberDeclaredOutsideProject, else fall through
//   A5  receiverIsImportedBuiltinContainer                     — pure
//   A6  receiverIsExternalInstance (annotation arm pure, checker arm not)
//   A7  calleeIsExternalLocalBinding (bare calls only)
//   A8  checkerResolvesCalleeOutsideProject
//   A9  jsxTagMemberDeclaredOutsideProject
//
// The precedence matrix this corpus pins (row decides before column; "—x—"
// marks the pair pinned by the case):
//
//   case                          | A0 | A2 | A3 | A4 | A5 | A7 | A8 | A9
//   ------------------------------+----+----+----+----+----+----+----+----
//   console bound by project import| —x—|    |    |    |    |    |    |
//   super vs member decl site      |    |    | —x—|    |    |    |    |
//   this vs super, one class       |    |    | —x—| —x—|    |    |    |
//   container vocab vs checker     |    |    |    |    | —x—|    | —x—|
//   bare vs this-bound local callee|    |    |    |    |    | —x—|    |
//   package import vs jsx arm      |    | —x—|    |    |    |    |    | —x—
//
// Program-null runs make the order observable: A3/A4/A6-checker/A7/A8/A9 all
// need a TSProgramCache, so a verdict that survives programCache === null was
// decided by a pure arm that sits above them.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CallContext, CallRef, SymbolDefinition } from "../../../../../../src/core/contracts/types/codegraph.js";
import { targetsExternalImport } from "../../../../../../src/core/domains/language/typescript/resolver/ts-external-call.js";
import { createProjectFileProbe } from "../../../../../../src/core/domains/language/typescript/resolver/ts-path-mapper.js";
import { TSProgramCache } from "../../../../../../src/core/domains/language/typescript/resolver/ts-program-cache.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const tsOptions = { baseUrl: ".", paths: {} };

function writeSource(repoRoot: string, relPath: string, lines: string[]): void {
  const abs = join(repoRoot, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `${lines.join("\n")}\n`, "utf8");
}

function writePackage(repoRoot: string, name: string, declaration: string): void {
  writeSource(repoRoot, `node_modules/${name}/package.json`, [
    JSON.stringify({ name, version: "1.0.0", types: "index.d.ts" }),
  ]);
  writeSource(repoRoot, `node_modules/${name}/index.d.ts`, [declaration]);
}

const sym = (symbolId: string, shortName: string, relPath: string, scope: string[]): SymbolDefinition => ({
  symbolId,
  fqName: symbolId,
  shortName,
  relPath,
  scope,
});

/** Project namesakes for every callee the checker-backed arms ask about. */
const precedenceTable = (): InMemoryGlobalSymbolTable => {
  const table = new InMemoryGlobalSymbolTable();
  table.upsertFile("src/store.ts", [sym("Store#setState", "setState", "src/store.ts", ["Store"])]);
  table.upsertFile("src/job-base.ts", [sym("JobBase#inheritedRun", "inheritedRun", "src/job-base.ts", ["JobBase"])]);
  table.upsertFile("src/sessions.ts", [sym("SessionLog#filter", "filter", "src/sessions.ts", ["SessionLog"])]);
  table.upsertFile("src/format-helpers.ts", [
    sym("FormatHelpers#setDate", "setDate", "src/format-helpers.ts", ["FormatHelpers"]),
  ]);
  table.upsertFile("src/legacy.ts", [sym("LegacyText#sanitize", "sanitize", "src/legacy.ts", ["LegacyText"])]);
  return table;
};

function writePrecedenceFixture(repoRoot: string): void {
  writePackage(
    repoRoot,
    "ui-pkg",
    ["export declare class Component<S> {", "  setState(next: S): void;", "  forceUpdate(): void;", "}"].join("\n"),
  );
  writePackage(
    repoRoot,
    "tree-sitter",
    [
      "export declare namespace Parser {",
      "  interface SyntaxNode {",
      "    child(index: number): SyntaxNode;",
      "  }",
      "}",
    ].join("\n"),
  );
  writePackage(
    repoRoot,
    "react",
    [
      "export type Dispatch<A> = (value: A) => void;",
      "export type SetStateAction<S> = S | ((prev: S) => S);",
      "export declare function useState<S>(initial: S): [S, Dispatch<SetStateAction<S>>];",
    ].join("\n"),
  );
  writePackage(
    repoRoot,
    "purify-pkg",
    [
      "export interface Purifier {",
      "  sanitize(html: string): string;",
      "}",
      "declare const purifier: Purifier;",
      "export default purifier;",
    ].join("\n"),
  );
  writePackage(repoRoot, "icons-pkg", "export declare const Refresh: (props: { size: number }) => string;");

  // Panel → Base(project) → Component(package): one class where this and super
  // disagree about the same inherited member.
  writeSource(repoRoot, "src/base.ts", [
    'import { Component } from "ui-pkg";',
    "export class Base extends Component<{ n: number }> {}",
  ]);
  writeSource(repoRoot, "src/panel.ts", [
    'import { Base } from "./base.js";',
    "export class Panel extends Base {",
    "  refresh(): void {",
    "    this.setState({ n: 1 });",
    "    super.setState({ n: 2 });",
    "  }",
    "}",
  ]);
  writeSource(repoRoot, "src/leaf.ts", [
    'import { Component } from "ui-pkg";',
    "export class Leaf extends Component<{ n: number }> {",
    "  tick(): void {",
    "    super.setState({ n: 3 });",
    "  }",
    "}",
  ]);
  writeSource(repoRoot, "src/job-base.ts", [
    "export class JobBase {",
    "  inheritedRun(): number {",
    "    return 1;",
    "  }",
    "}",
  ]);
  writeSource(repoRoot, "src/job.ts", [
    'import { JobBase } from "./job-base.js";',
    "export class Job extends JobBase {",
    "  go(): number {",
    "    return this.inheritedRun();",
    "  }",
    "}",
  ]);

  // SessionLog declares `filter` IN the project, and the caller binds the
  // receiver through a project-relative import — so A2 declines and the
  // container arm answers before the checker could rescue its own declaration.
  writeSource(repoRoot, "src/sessions.ts", [
    "export class SessionLog {",
    "  filter(keep: (s: string) => boolean): string[] {",
    "    return [];",
    "  }",
    "}",
    "export const SESS: SessionLog = new SessionLog();",
  ]);
  writeSource(repoRoot, "src/report.ts", [
    'import { SESS } from "./sessions.js";',
    "export function recent(): string[] {",
    "  return SESS.filter((s) => s.length > 0);",
    "}",
  ]);

  // Annotated receivers: package annotation (external) vs project annotation.
  writeSource(repoRoot, "src/walker.ts", [
    'import type { Parser } from "tree-sitter";',
    "",
    "export function firstChild(native: Parser.SyntaxNode): void {",
    "  native.child(0);",
    "}",
  ]);
  writeSource(repoRoot, "src/store.ts", [
    "export class Store {",
    "  setState(next: { n: number }): void {",
    "    void next;",
    "  }",
    "  put(key: string): void {",
    "    void key;",
    "  }",
    "}",
  ]);
  writeSource(repoRoot, "src/store-caller.ts", [
    'import { Store } from "./store.js";',
    "export function save(store: Store): void {",
    '  store.put("k");',
    "}",
  ]);

  // Local-callee pair: the bare hook setter (external signature) and the same
  // member name through a receiver the local-binding arm cannot see.
  writeSource(repoRoot, "src/date-filter.ts", [
    'import { useState } from "react";',
    "",
    "export function DateFilter(next: Date): void {",
    "  const [date, setDate] = useState(new Date());",
    "  void date;",
    "  setDate(next);",
    "}",
  ]);
  writeSource(repoRoot, "src/hook-panel.ts", [
    "export class HookPanel {",
    "  run(next: Date): void {",
    "    this.setDate(next);",
    "  }",
    "}",
  ]);

  // Checker-callee baseline: callee re-exported out of the project.
  writeSource(repoRoot, "src/sanitize-helper.ts", [
    'import purifier from "purify-pkg";',
    "",
    "export const { sanitize } = purifier;",
  ]);
  writeSource(repoRoot, "src/render.ts", [
    'import { sanitize } from "./sanitize-helper.js";',
    "",
    "export function render(html: string): string {",
    "  return sanitize(html);",
    "}",
  ]);

  // JSX pair: the same dotted tag bound by a package import (decided at A2)
  // vs bound through a project re-export (only the jsx arm can answer).
  writeSource(repoRoot, "src/themes.ts", ['export { Refresh } from "icons-pkg";']);
  writeSource(repoRoot, "src/page.tsx", [
    'import * as Themes from "./themes.js";',
    "export const page = <Themes.Refresh />;",
  ]);
  writeSource(repoRoot, "src/icon-page.tsx", [
    'import * as Icons from "icons-pkg";',
    "export const iconPage = <Icons.Refresh />;",
  ]);
}

describe("targetsExternalImport — guard precedence corpus (tea-rags-mcp-0qaht.4)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-external-precedence-")));
    writePrecedenceFixture(repoRoot);
  });
  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const fileExists = (): ReturnType<typeof createProjectFileProbe> => createProjectFileProbe(repoRoot);
  const withProgram = (call: CallRef, ctx: CallContext): boolean =>
    targetsExternalImport(call, ctx, tsOptions, new TSProgramCache({ repoRoot, tsOptions }), fileExists());
  const withoutProgram = (call: CallRef, ctx: CallContext): boolean =>
    targetsExternalImport(call, ctx, tsOptions, null, fileExists());

  const ctx = (callerFile: string, over: Partial<CallContext> = {}): CallContext => ({
    callerFile,
    callerScope: [],
    imports: [],
    symbolTable: precedenceTable(),
    ...over,
  });

  describe("pre-arms decide before every composed guard", () => {
    it("counts an ECMAScript-global receiver external with no Program and no imports (console.log)", () => {
      const call: CallRef = { callText: "console.log(x)", receiver: "console", member: "log", startLine: 1 };
      expect(withoutProgram(call, ctx("src/report.ts"))).toBe(true);
    });

    it("lets the globals check shadow an import binding — `console` bound by a project-relative import still decides first (A0 over A2)", () => {
      const call: CallRef = { callText: "console.log(x)", receiver: "console", member: "log", startLine: 1 };
      const bound: CallContext = ctx("src/report.ts", {
        imports: [{ importText: "./console-helpers.js", startLine: 1, importedNames: ["console"] }],
      });
      // Had A2 run first, the project-relative binding would decline and the
      // program-less chain would end internal. A0 answers before the loop.
      expect(withoutProgram(call, bound)).toBe(true);
    });

    it("counts a bare ambient global callable external with no Program (parseInt(x))", () => {
      const call: CallRef = { callText: "parseInt(x)", receiver: null, member: "parseInt", startLine: 1 };
      expect(withoutProgram(call, ctx("src/report.ts"))).toBe(true);
    });

    it("counts a receiver bound by a package import external with no Program (client.query())", () => {
      const call: CallRef = { callText: "client.query(q)", receiver: "client", member: "query", startLine: 1 };
      const bound: CallContext = ctx("src/report.ts", {
        imports: [{ importText: "api-pkg", startLine: 1, importedNames: ["client"] }],
      });
      expect(withoutProgram(call, bound)).toBe(true);
    });

    it("declines a project-relative binding with no container vocabulary and no Program (SESS.summarize())", () => {
      const call: CallRef = { callText: "SESS.summarize()", receiver: "SESS", member: "summarize", startLine: 3 };
      const bound: CallContext = ctx("src/report.ts", {
        imports: [{ importText: "./sessions.js", startLine: 1, importedNames: ["SESS"] }],
      });
      expect(withoutProgram(call, bound)).toBe(false);
    });
  });

  describe("super's verdict is final (case 9)", () => {
    it("counts super external when the extended package declares the base (Leaf → Component)", () => {
      const call: CallRef = {
        callText: "super.setState({ n: 3 })",
        receiver: "super",
        member: "setState",
        startLine: 4,
      };
      const leafCtx = ctx("src/leaf.ts", {
        callerScope: ["Leaf"],
        imports: [{ importText: "ui-pkg", startLine: 1, importedNames: ["Component"] }],
      });
      expect(withProgram(call, leafCtx)).toBe(true);
    });

    it("returns the super guard's internal verdict directly — the member's package declaration site never rescues it", () => {
      const call: CallRef = {
        callText: "super.setState({ n: 2 })",
        receiver: "super",
        member: "setState",
        startLine: 5,
      };
      const panelCtx = ctx("src/panel.ts", {
        callerScope: ["Panel"],
        imports: [{ importText: "./base.js", startLine: 1, importedNames: ["Base"] }],
      });
      // Base is a project file, so the super arm answers internal and RETURNS —
      // the chain below (which would also decline: the receiver expression
      // `super` types as the project Base) is never consulted. The early
      // return is the pin: no later arm can flip this verdict.
      expect(withProgram(call, panelCtx)).toBe(false);
    });

    it("splits this vs super in one class: this.setState external, super.setState internal (Panel → Base → Component)", () => {
      const panelCtx = ctx("src/panel.ts", {
        callerScope: ["Panel"],
        imports: [{ importText: "./base.js", startLine: 1, importedNames: ["Base"] }],
      });
      const viaThis: CallRef = {
        callText: "this.setState({ n: 1 })",
        receiver: "this",
        member: "setState",
        startLine: 4,
      };
      const viaSuper: CallRef = {
        callText: "super.setState({ n: 2 })",
        receiver: "super",
        member: "setState",
        startLine: 5,
      };
      // this-member follows the member's DECLARATION SITE through the chain —
      // Component.setState sits in the package, so external. super looks at the
      // immediate base TYPE only — Base is a project class, so internal.
      expect(withProgram(viaThis, panelCtx)).toBe(true);
      expect(withProgram(viaSuper, panelCtx)).toBe(false);
    });
  });

  describe("this-member (case 10) against the rest of the chain", () => {
    it("keeps this.inheritedRun internal when a project base declares it", () => {
      const call: CallRef = {
        callText: "this.inheritedRun()",
        receiver: "this",
        member: "inheritedRun",
        startLine: 4,
      };
      const jobCtx = ctx("src/job.ts", {
        callerScope: ["Job"],
        imports: [{ importText: "./job-base.js", startLine: 1, importedNames: ["JobBase"] }],
      });
      expect(withProgram(call, jobCtx)).toBe(false);
    });
  });

  describe("imported-builtin-container (case 5) outranks the checker arms", () => {
    const reportCtx = (): CallContext =>
      ctx("src/report.ts", {
        imports: [{ importText: "./sessions.js", startLine: 1, importedNames: ["SESS"] }],
      });
    const filterCall: CallRef = {
      callText: "SESS.filter((s) => s.length > 0)",
      receiver: "SESS",
      member: "filter",
      startLine: 3,
    };

    it("counts SESS.filter external with no Program — the container arm needs no checker", () => {
      expect(withoutProgram(filterCall, reportCtx())).toBe(true);
    });

    it("keeps SESS.filter external with a Program even though SessionLog#filter is a project declaration the checker would rescue", () => {
      // With a Program the checker arm COULD answer: the resolved signature is
      // the project's own SessionLog#filter, which receiverNamesProjectDeclaration
      // would keep internal. The container arm sits above it and answers first.
      expect(withProgram(filterCall, reportCtx())).toBe(true);
    });

    it("declines the same vocabulary on a receiver no import binds (rows.map)", () => {
      // `sessions` would NOT do here: ./sessions.js binds it through the import
      // SPECIFIER's basename (the pinned module-basename arm of the container
      // guard), so the verdict would flip to external. `rows` binds nothing.
      const call: CallRef = { callText: "rows.map(f)", receiver: "rows", member: "map", startLine: 3 };
      expect(withoutProgram(call, reportCtx())).toBe(false);
    });
  });

  describe("external-instance (cases 3/4) — annotation origin decides before the checker", () => {
    it("counts native.child external on a package annotation with no Program (Parser.SyntaxNode)", () => {
      const call: CallRef = { callText: "native.child(0)", receiver: "native", member: "child", startLine: 4 };
      const walkerCtx = ctx("src/walker.ts", {
        imports: [{ importText: "tree-sitter", startLine: 1, importedNames: ["Parser"] }],
        localBindings: { native: [{ line: 3, type: "Parser.SyntaxNode" }] },
      });
      expect(withoutProgram(call, walkerCtx)).toBe(true);
    });

    it("keeps store.put internal on a project annotation, with and without a Program", () => {
      const call: CallRef = { callText: 'store.put("k")', receiver: "store", member: "put", startLine: 3 };
      const storeCtx = ctx("src/store-caller.ts", {
        imports: [{ importText: "./store.js", startLine: 1, importedNames: ["Store"] }],
        localBindings: { store: [{ line: 2, type: "Store" }] },
      });
      expect(withoutProgram(call, storeCtx)).toBe(false);
      expect(withProgram(call, storeCtx)).toBe(false);
    });
  });

  describe("external-local-binding (case 6) is bare-only; checker-callee (case 7) and jsx follow", () => {
    it("counts the bare hook setter external even with a project namesake (setDate)", () => {
      const call: CallRef = { callText: "setDate(next)", receiver: null, member: "setDate", startLine: 6 };
      const filterCtx = ctx("src/date-filter.ts", {
        imports: [{ importText: "react", startLine: 1, importedNames: ["useState"] }],
      });
      // The FormatHelpers#setDate namesake satisfies the checker arm's
      // precondition too — the local-binding arm answers first either way.
      expect(withProgram(call, filterCtx)).toBe(true);
    });

    it("declines the same member through a receiver — the local-binding arm never sees this.setDate", () => {
      const call: CallRef = {
        callText: "this.setDate(next)",
        receiver: "this",
        member: "setDate",
        startLine: 3,
      };
      const panelCtx = ctx("src/hook-panel.ts", { callerScope: ["HookPanel"] });
      // classifyLocalCallee returns notLocalBinding for any receiver-bearing
      // call, and no other arm can place an undeclared this.setDate: the pair
      // pins that receiver shape alone routes the verdict.
      expect(withProgram(call, panelCtx)).toBe(false);
    });

    it("counts a callee re-exported out of the project external (sanitize)", () => {
      const call: CallRef = { callText: "sanitize(html)", receiver: null, member: "sanitize", startLine: 4 };
      const renderCtx = ctx("src/render.ts", {
        imports: [{ importText: "./sanitize-helper.js", startLine: 1, importedNames: ["sanitize"] }],
      });
      expect(withProgram(call, renderCtx)).toBe(true);
    });

    it("decides an import-bound JSX tag at the import arm — external with no Program (Icons.Refresh)", () => {
      const call: CallRef = {
        callText: "<Icons.Refresh />",
        receiver: "Icons",
        member: "Refresh",
        startLine: 2,
        jsx: true,
      };
      const iconCtx = ctx("src/icon-page.tsx", {
        imports: [{ importText: "icons-pkg", startLine: 1, importedNames: ["Icons"] }],
      });
      // The jsx arm needs a Program; the verdict survives programCache ===
      // null, so A2 (package import binding the receiver) decided it.
      expect(withoutProgram(call, iconCtx)).toBe(true);
    });

    it("keeps a project-re-exported namespace tag internal without a Program (Themes.Refresh)", () => {
      const call: CallRef = {
        callText: "<Themes.Refresh />",
        receiver: "Themes",
        member: "Refresh",
        startLine: 2,
        jsx: true,
      };
      const pageCtx = ctx("src/page.tsx", {
        imports: [{ importText: "./themes.js", startLine: 1, importedNames: ["Themes"] }],
      });
      // ./themes.js maps to a project file, so A2 declines — and with no
      // Program nothing below it can answer.
      expect(withoutProgram(call, pageCtx)).toBe(false);
    });

    it("counts that same tag external with a Program — the jsx arm reads the member's declaration site", () => {
      const call: CallRef = {
        callText: "<Themes.Refresh />",
        receiver: "Themes",
        member: "Refresh",
        startLine: 2,
        jsx: true,
      };
      const pageCtx = ctx("src/page.tsx", {
        imports: [{ importText: "./themes.js", startLine: 1, importedNames: ["Themes"] }],
      });
      // resolveAlias follows the re-export: Refresh's declarations all sit in
      // node_modules/icons-pkg, so the last arm answers external.
      expect(withProgram(call, pageCtx)).toBe(true);
    });
  });
});
