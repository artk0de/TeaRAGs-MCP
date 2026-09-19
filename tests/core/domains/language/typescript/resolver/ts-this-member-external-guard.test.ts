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
import { targetsExternalImport } from "../../../../../../src/core/domains/language/typescript/resolver/ts-external-call.js";
import { TSProgramCache } from "../../../../../../src/core/domains/language/typescript/resolver/ts-program-cache.js";
import { TSCallResolver } from "../../../../../../src/core/domains/language/typescript/resolver/ts-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const tsOptions = { baseUrl: ".", paths: {} };

function writeSource(repoRoot: string, relPath: string, lines: string[]): void {
  const abs = join(repoRoot, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `${lines.join("\n")}\n`, "utf8");
}

const sym = (symbolId: string, shortName: string, relPath: string, scope: string[]): NamedSymbol => ({
  symbolId,
  fqName: symbolId,
  shortName,
  relPath,
  scope,
});

/**
 * A class extending a dependency's `Component`, one extending a project base,
 * and one overriding the dependency's member — with the walker's view of them
 * in the symbol table beside unrelated project namesakes of the dependency's
 * members (`Store#setState`, `Registry#hasOwnProperty`), which is what makes a
 * miss on those members count as a miss today.
 */
function writeFixture(repoRoot: string): void {
  writeSource(repoRoot, "node_modules/ui-pkg/package.json", [
    JSON.stringify({ name: "ui-pkg", version: "1.0.0", types: "index.d.ts" }),
  ]);
  writeSource(repoRoot, "node_modules/ui-pkg/index.d.ts", [
    "export declare class Component<S> {",
    "  setState(next: S): void;",
    "  forceUpdate(): void;",
    "}",
  ]);
  writeSource(repoRoot, "src/base.ts", [
    "export class Base {",
    "  inheritedRun(): number {",
    "    return 1;",
    "  }",
    "}",
  ]);
  writeSource(repoRoot, "src/form.ts", [
    'import { Component } from "ui-pkg";',
    'import { Base } from "./base.js";',
    "export class Form extends Component<{ n: number }> {",
    "  submit(): boolean {",
    "    this.setState({ n: 1 });",
    "    this.forceUpdate();",
    '    return this.hasOwnProperty("n");',
    "  }",
    "}",
    "export class Job extends Base {",
    "  go(): number {",
    "    return this.inheritedRun();",
    "  }",
    "}",
  ]);
  writeSource(repoRoot, "src/panel.ts", [
    'import { Component } from "ui-pkg";',
    "export class Panel extends Component<{ n: number }> {",
    "  setState(next: { n: number }): void {",
    "    super.setState(next);",
    "  }",
    "  refresh(): void {",
    "    this.setState({ n: 2 });",
    "  }",
    "}",
  ]);
}

const table = (): InMemoryGlobalSymbolTable => {
  const t = new InMemoryGlobalSymbolTable();
  t.upsertFile("src/base.ts", [
    sym("Base", "Base", "src/base.ts", []),
    sym("Base#inheritedRun", "inheritedRun", "src/base.ts", ["Base"]),
  ]);
  t.upsertFile("src/form.ts", [
    sym("Form", "Form", "src/form.ts", []),
    sym("Form#submit", "submit", "src/form.ts", ["Form"]),
    sym("Job", "Job", "src/form.ts", []),
    sym("Job#go", "go", "src/form.ts", ["Job"]),
  ]);
  t.upsertFile("src/panel.ts", [
    sym("Panel", "Panel", "src/panel.ts", []),
    sym("Panel#setState", "setState", "src/panel.ts", ["Panel"]),
    sym("Panel#refresh", "refresh", "src/panel.ts", ["Panel"]),
  ]);
  t.upsertFile("src/store.ts", [
    sym("Store#setState", "setState", "src/store.ts", ["Store"]),
    sym("Registry#hasOwnProperty", "hasOwnProperty", "src/store.ts", ["Registry"]),
  ]);
  return t;
};

const UI_PKG_IMPORT = {
  importText: "ui-pkg",
  startLine: 1,
  importedNames: ["Component"],
  importedBindings: { Component: "Component" },
};

const formCtx = (callerScope: string[]): CallContext => ({
  callerFile: "src/form.ts",
  callerScope,
  imports: [
    UI_PKG_IMPORT,
    { importText: "./base.js", startLine: 2, importedNames: ["Base"], importedBindings: { Base: "Base" } },
  ],
  symbolTable: table(),
});

const panelCtx = (): CallContext => ({
  callerFile: "src/panel.ts",
  callerScope: ["Panel"],
  imports: [UI_PKG_IMPORT],
  symbolTable: table(),
});

const thisCall = (callText: string, member: string, startLine: number): CallRef => ({
  callText,
  receiver: "this",
  member,
  startLine,
});

const SET_STATE = thisCall("this.setState({ n: 1 })", "setState", 5);
const FORCE_UPDATE = thisCall("this.forceUpdate()", "forceUpdate", 6);
const HAS_OWN = thisCall('this.hasOwnProperty("n")', "hasOwnProperty", 7);
const INHERITED = thisCall("this.inheritedRun()", "inheritedRun", 12);
const OVERRIDDEN = thisCall("this.setState({ n: 2 })", "setState", 7);

/**
 * Case 10 of `targetsExternalImport` (bd tea-rags-mcp-t5cji, L3-2): a `this`
 * member the checker declares entirely outside the project is an external call,
 * the `this` twin of case 9's `super` into an out-of-project base. Once the
 * evidence guard stopped committing `this.setState` to a project namesake, it
 * was charged as an internal miss nothing can fix — taxdome's TS dynamic rate
 * fell 0.8980 → 0.8815.
 */
describe("targetsExternalImport — a `this` member declared outside the project (bd tea-rags-mcp-t5cji)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-this-external-")));
    writeFixture(repoRoot);
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const external = (call: CallRef, ctx: CallContext): boolean =>
    targetsExternalImport(call, ctx, tsOptions, new TSProgramCache({ repoRoot, tsOptions }));

  it("counts a member the extended dependency declares as external", () => {
    expect(external(SET_STATE, formCtx(["Form"]))).toBe(true);
  });

  it("counts a member the default lib declares as external", () => {
    expect(external(HAS_OWN, formCtx(["Form"]))).toBe(true);
  });

  it("keeps a member a project base declares internal", () => {
    expect(external(INHERITED, formCtx(["Job"]))).toBe(false);
  });

  it("keeps a member the enclosing class overrides internal — one project declaration is enough", () => {
    expect(external(OVERRIDDEN, panelCtx())).toBe(false);
  });

  it("says nothing when no project symbol shares the name — that call is already `noInProjectDef`", () => {
    expect(external(FORCE_UPDATE, formCtx(["Form"]))).toBe(false);
  });

  it("says nothing without a Program", () => {
    expect(targetsExternalImport(SET_STATE, formCtx(["Form"]), tsOptions, null)).toBe(false);
  });

  it("is the verdict the resolver's miss classifier reads", () => {
    const resolver = new TSCallResolver(tsOptions, DEFAULT_AMBIGUOUS_RESOLVE_MODE, repoRoot);
    expect(resolver.resolve(SET_STATE, formCtx(["Form"]))).toBeNull();
    expect(resolver.targetsExternalImport(SET_STATE, formCtx(["Form"]))).toBe(true);
  });
});
