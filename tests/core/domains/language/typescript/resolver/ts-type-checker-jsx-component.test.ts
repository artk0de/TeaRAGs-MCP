import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CallContext, CallRef } from "../../../../../../src/core/contracts/types/codegraph.js";
import { TSTypeCheckerJsxComponentSymbolResolutionStrategy } from "../../../../../../src/core/domains/language/typescript/resolver/strategies/ts-type-checker-jsx-component.js";
import { TSProgramCache } from "../../../../../../src/core/domains/language/typescript/resolver/ts-program-cache.js";
import { TSCallResolver } from "../../../../../../src/core/domains/language/typescript/resolver/ts-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function writeSource(root: string, relPath: string, content: string): void {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

/**
 * A component corpus covering the four ways a `.tsx` file names a component it
 * did not declare: default import, namespace member, barrel re-export, and a
 * renamed named import. Line numbers of `src/page.tsx` are load-bearing —
 * `CallRef.startLine` is how the strategy finds the tag.
 */
function writeComponentCorpus(repoRoot: string): void {
  writeSource(
    repoRoot,
    "src/button.tsx",
    `export default function Button(props: { label: string }) {\n  return null;\n}\n`,
  );
  writeSource(
    repoRoot,
    "src/ui.tsx",
    `export function Panel() {\n  return null;\n}\n\nexport const Chip = (props: { n: number }) => null;\n`,
  );
  writeSource(repoRoot, "src/barrel.ts", `export { Panel } from "./ui.js";\n`);
  writeSource(
    repoRoot,
    "src/page.tsx",
    [
      `import Button from "./button.js";`, // 1
      `import * as UI from "./ui.js";`, // 2
      `import { Panel } from "./barrel.js";`, // 3
      `import { Chip as Tag } from "./ui.js";`, // 4
      ``, // 5
      `function Local() {`, // 6
      `  return null;`, // 7
      `}`, // 8
      ``, // 9
      `export function Page() {`, // 10
      `  return (`, // 11
      `    <div>`, // 12
      `      <Button label="ok" />`, // 13
      `      <UI.Panel />`, // 14
      `      <Panel />`, // 15
      `      <Tag n={1} />`, // 16
      `      <Local />`, // 17
      `    </div>`, // 18
      `  );`, // 19
      `}`, // 20
      ``,
    ].join("\n"),
  );
}

/** What the chunker records for the corpus above. */
function componentSymbolTable(): InMemoryGlobalSymbolTable {
  const symbolTable = new InMemoryGlobalSymbolTable();
  symbolTable.upsertFile("src/button.tsx", [
    { symbolId: "Button", fqName: "Button", shortName: "Button", relPath: "src/button.tsx", scope: [] },
  ]);
  symbolTable.upsertFile("src/ui.tsx", [
    { symbolId: "Panel", fqName: "Panel", shortName: "Panel", relPath: "src/ui.tsx", scope: [] },
    { symbolId: "Chip", fqName: "Chip", shortName: "Chip", relPath: "src/ui.tsx", scope: [] },
  ]);
  symbolTable.upsertFile("src/page.tsx", [
    { symbolId: "Local", fqName: "Local", shortName: "Local", relPath: "src/page.tsx", scope: [] },
    { symbolId: "Page", fqName: "Page", shortName: "Page", relPath: "src/page.tsx", scope: [] },
  ]);
  return symbolTable;
}

function pageContext(symbolTable: InMemoryGlobalSymbolTable): CallContext {
  return {
    callerFile: "src/page.tsx",
    callerScope: [],
    imports: [
      { importText: "./button.js", startLine: 1, importedNames: ["Button"] },
      { importText: "./ui.js", startLine: 2, importedNames: ["UI"] },
      { importText: "./barrel.js", startLine: 3, importedNames: ["Panel"] },
      { importText: "./ui.js", startLine: 4, importedNames: ["Tag"] },
    ],
    symbolTable,
  };
}

function jsxCall(overrides: Partial<CallRef> & Pick<CallRef, "member" | "startLine">): CallRef {
  return { callText: `<${overrides.member} />`, receiver: null, jsx: true, ...overrides };
}

describe("TSTypeCheckerJsxComponentSymbolResolutionStrategy resolves a JSX tag to its component (bd tea-rags-mcp-b4pvp)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-jsx-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function buildStrategy(root: string = repoRoot): TSTypeCheckerJsxComponentSymbolResolutionStrategy {
    const tsOptions = { baseUrl: ".", paths: {} };
    return new TSTypeCheckerJsxComponentSymbolResolutionStrategy(
      { tsOptions, mode: "strict" },
      new TSProgramCache({ repoRoot: root, tsOptions }),
    );
  }

  it("resolves a default-imported component to the file that declares it", () => {
    writeComponentCorpus(repoRoot);

    const outcome = buildStrategy().attempt(
      jsxCall({ callText: '<Button label="ok" />', member: "Button", startLine: 13 }),
      pageContext(componentSymbolTable()),
    );

    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/button.tsx", targetSymbolId: "Button" },
    });
  });

  it("resolves a namespace-qualified tag through the namespace import", () => {
    writeComponentCorpus(repoRoot);

    const outcome = buildStrategy().attempt(
      { callText: "<UI.Panel />", receiver: "UI", member: "Panel", startLine: 14, jsx: true },
      pageContext(componentSymbolTable()),
    );

    expect(outcome).toEqual({ kind: "resolved", target: { targetRelPath: "src/ui.tsx", targetSymbolId: "Panel" } });
  });

  it("follows a barrel re-export to the file that really declares the component", () => {
    writeComponentCorpus(repoRoot);

    const outcome = buildStrategy().attempt(
      jsxCall({ member: "Panel", startLine: 15 }),
      pageContext(componentSymbolTable()),
    );

    expect(outcome).toEqual({ kind: "resolved", target: { targetRelPath: "src/ui.tsx", targetSymbolId: "Panel" } });
  });

  it("resolves a renamed import to the component's real name, not the local alias", () => {
    writeComponentCorpus(repoRoot);

    const outcome = buildStrategy().attempt(
      { callText: "<Tag n={1} />", receiver: null, member: "Tag", startLine: 16, jsx: true },
      pageContext(componentSymbolTable()),
    );

    expect(outcome).toEqual({ kind: "resolved", target: { targetRelPath: "src/ui.tsx", targetSymbolId: "Chip" } });
  });

  it("resolves a component declared in the caller's own file", () => {
    writeComponentCorpus(repoRoot);

    const outcome = buildStrategy().attempt(
      jsxCall({ member: "Local", startLine: 17 }),
      pageContext(componentSymbolTable()),
    );

    expect(outcome).toEqual({ kind: "resolved", target: { targetRelPath: "src/page.tsx", targetSymbolId: "Local" } });
  });

  it("emits a file-only edge for an anonymous default export, rather than inventing an id", () => {
    writeSource(repoRoot, "src/anon.tsx", `export default () => null;\n`);
    writeSource(
      repoRoot,
      "src/page.tsx",
      [`import Anon from "./anon.js";`, ``, `export function Page() {`, `  return <Anon />;`, `}`, ``].join("\n"),
    );

    const outcome = buildStrategy().attempt(jsxCall({ member: "Anon", startLine: 4 }), {
      callerFile: "src/page.tsx",
      callerScope: [],
      imports: [{ importText: "./anon.js", startLine: 1, importedNames: ["Anon"] }],
      symbolTable: new InMemoryGlobalSymbolTable(),
    });

    expect(outcome).toEqual({ kind: "resolved", target: { targetRelPath: "src/anon.tsx", targetSymbolId: null } });
  });

  it("continues when the component is declared outside the project", () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "ts-jsx-ws-")));
    try {
      const projectRoot = join(workspace, "repo");
      writeSource(workspace, "vendor/widget.tsx", `export function Widget() {\n  return null;\n}\n`);
      writeSource(
        projectRoot,
        "src/page.tsx",
        [
          `import { Widget } from "../../vendor/widget.js";`,
          ``,
          `export function Page() {`,
          `  return <Widget />;`,
          `}`,
          ``,
        ].join("\n"),
      );

      const outcome = buildStrategy(projectRoot).attempt(jsxCall({ member: "Widget", startLine: 4 }), {
        callerFile: "src/page.tsx",
        callerScope: [],
        imports: [{ importText: "../../vendor/widget.js", startLine: 1, importedNames: ["Widget"] }],
        symbolTable: new InMemoryGlobalSymbolTable(),
      });

      expect(outcome).toEqual({ kind: "continue" });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("falls back to the declaration's short name when that file composes the id differently", () => {
    writeComponentCorpus(repoRoot);
    // The chunker filed Panel under a namespace-composed id. The checker still
    // names the right file and the right component, so narrowing the short name
    // to that one file recovers the target instead of dropping to a file-only edge.
    const symbolTable = componentSymbolTable();
    symbolTable.upsertFile("src/ui.tsx", [
      { symbolId: "Widgets.Panel", fqName: "Widgets.Panel", shortName: "Panel", relPath: "src/ui.tsx", scope: [] },
    ]);

    const outcome = buildStrategy().attempt(jsxCall({ member: "Panel", startLine: 15 }), pageContext(symbolTable));

    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/ui.tsx", targetSymbolId: "Widgets.Panel" },
    });
  });

  it("continues when the tag's import specifier names no file, so the alias has no declaration", () => {
    writeSource(
      repoRoot,
      "src/page.tsx",
      [`import { Ghost } from "./nowhere.js";`, ``, `export function Page() {`, `  return <Ghost />;`, `}`, ``].join(
        "\n",
      ),
    );

    const outcome = buildStrategy().attempt(jsxCall({ member: "Ghost", startLine: 4 }), {
      callerFile: "src/page.tsx",
      callerScope: [],
      imports: [{ importText: "./nowhere.js", startLine: 1, importedNames: ["Ghost"] }],
      symbolTable: new InMemoryGlobalSymbolTable(),
    });

    expect(outcome).toEqual({ kind: "continue" });
  });

  it("scans past an XML-namespaced tag sharing the line to reach the component tag", () => {
    writeSource(repoRoot, "src/widget.tsx", `export function Widget() {\n  return null;\n}\n`);
    writeSource(
      repoRoot,
      "src/page.tsx",
      [
        `import { Widget } from "./widget.js";`,
        ``,
        `export function Page() {`,
        `  return <svg><svg:circle /><Widget /></svg>;`,
        `}`,
        ``,
      ].join("\n"),
    );
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("src/widget.tsx", [
      { symbolId: "Widget", fqName: "Widget", shortName: "Widget", relPath: "src/widget.tsx", scope: [] },
    ]);

    const outcome = buildStrategy().attempt(jsxCall({ member: "Widget", startLine: 4 }), {
      callerFile: "src/page.tsx",
      callerScope: [],
      imports: [{ importText: "./widget.js", startLine: 1, importedNames: ["Widget"] }],
      symbolTable,
    });

    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/widget.tsx", targetSymbolId: "Widget" },
    });
  });

  it("continues when the tag binds to no symbol at all", () => {
    writeSource(repoRoot, "src/page.tsx", [`export function Page() {`, `  return <Missing />;`, `}`, ``].join("\n"));

    const outcome = buildStrategy().attempt(jsxCall({ member: "Missing", startLine: 2 }), {
      callerFile: "src/page.tsx",
      callerScope: [],
      imports: [],
      symbolTable: new InMemoryGlobalSymbolTable(),
    });

    expect(outcome).toEqual({ kind: "continue" });
  });

  it("continues when no JSX tag sits at the recorded line", () => {
    writeComponentCorpus(repoRoot);

    const outcome = buildStrategy().attempt(
      jsxCall({ member: "Button", startLine: 6 }),
      pageContext(componentSymbolTable()),
    );

    expect(outcome).toEqual({ kind: "continue" });
  });

  it("continues when no Program can be built for the caller file", () => {
    const outcome = buildStrategy().attempt(
      jsxCall({ member: "Button", startLine: 13 }),
      pageContext(componentSymbolTable()),
    );

    expect(outcome).toEqual({ kind: "continue" });
  });

  it("continues on an ordinary call without building a Program", () => {
    writeComponentCorpus(repoRoot);
    const tsOptions = { baseUrl: ".", paths: {} };
    const cache = new TSProgramCache({ repoRoot, tsOptions });
    const strategy = new TSTypeCheckerJsxComponentSymbolResolutionStrategy({ tsOptions, mode: "strict" }, cache);

    const outcome = strategy.attempt(
      { callText: "render(node)", receiver: null, member: "render", startLine: 13 },
      pageContext(componentSymbolTable()),
    );

    expect(outcome).toEqual({ kind: "continue" });
    expect(cache.size).toBe(0);
  });
});

describe("TSCallResolver resolves JSX component tags through its chain (bd tea-rags-mcp-b4pvp)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-jsx-chain-")));
    writeComponentCorpus(repoRoot);
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
    delete process.env.CODEGRAPH_TS_TYPECHECKER;
  });

  it("resolves a renamed-import tag no tree-sitter pass can name", () => {
    const resolver = new TSCallResolver({ baseUrl: ".", paths: {} }, "strict", repoRoot);

    const target = resolver.resolve(
      { callText: "<Tag n={1} />", receiver: null, member: "Tag", startLine: 16, jsx: true },
      pageContext(componentSymbolTable()),
    );

    expect(target).toEqual({ targetRelPath: "src/ui.tsx", targetSymbolId: "Chip" });
  });

  it("leaves the same tag unresolved when CODEGRAPH_TS_TYPECHECKER disables the checker passes", () => {
    process.env.CODEGRAPH_TS_TYPECHECKER = "0";
    const resolver = new TSCallResolver({ baseUrl: ".", paths: {} }, "strict", repoRoot);

    const target = resolver.resolve(
      { callText: "<Tag n={1} />", receiver: null, member: "Tag", startLine: 16, jsx: true },
      pageContext(componentSymbolTable()),
    );

    expect(target).toBeNull();
  });
});
