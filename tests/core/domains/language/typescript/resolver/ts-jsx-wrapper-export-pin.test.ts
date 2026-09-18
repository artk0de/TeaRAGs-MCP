import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CallContext, CallRef } from "../../../../../../src/core/contracts/types/codegraph.js";
import { TSCallResolver } from "../../../../../../src/core/domains/language/typescript/resolver/ts-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

/**
 * bd tea-rags-mcp-ex28m — a JSX tag naming a WRAPPER-EXPORTED component must
 * resolve to a PINNED symbol, never to a file-only edge.
 *
 * INCIDENT. taxdome's TS edges sat at 58,602 against a ~99,583 baseline and a
 * clean user-authorized recompute (12,823 TS files, ~176s) changed NOTHING —
 * byte-identical edge count, ConfirmationModal.tsx still 5 rows. Tracing the
 * real file through the real chain with the checker ON showed why, and it was
 * not a resolution failure at all: all six JSX tags RESOLVED, but five resolved
 * to `targetSymbolId: null`.
 *
 *   <Modal>      -> shared/Modal/Modal.tsx        targetSymbolId null
 *   <Layout> x2  -> ui-kit/Layout/Layout.tsx      targetSymbolId null
 *   <Button> x2  -> ui-kit/Button/Button.tsx      targetSymbolId null
 *   <Preloader>  -> ui-kit/Preloader/Preloader.tsx  targetSymbolId "Preloader"
 *
 * and `DuckDbFileGraphStore#writeFileRowsGroup` skips every edge whose
 * `targetSymbolId` is null (`file-graph-store.ts`, `if (e.targetSymbolId ===
 * null) continue`) — it has to, because `target_symbol_id` is a PRIMARY KEY
 * column and DuckDB forces PK columns NOT NULL. So five of six edges were
 * discarded at write time, silently, and only `<Preloader />` reached the table.
 * That is exactly the one JSX row the live graph holds for this file.
 *
 * WHY those five and not Preloader: the export shape, not the name.
 * `Preloader` is a plain `export function Preloader`, so the checker's
 * declaration carries that name and the symbol table confirms it. The others
 * use the wrapper-export pattern — `export { memoized as Modal }` at
 * Modal.tsx:122, `export { refForwarded as Layout }` at Layout.tsx:105 — where
 * the checker's alias lands on the INTERNAL binding (`memoized`,
 * `refForwarded`), a name the chunker never recorded. `pinSymbol` then found
 * nothing and degraded to a file-only edge, on the reasoning that the contract
 * permits a null `targetSymbolId`. The persistence layer does not.
 *
 * The fix keeps the checker's FILE decision — that half was never wrong — and
 * falls back to the TAG's own name scoped to that one file when the
 * declaration's internal name pins nothing. Namesakes elsewhere in the project
 * are irrelevant: the file is already proven.
 *
 * These cases go through the whole `TSCallResolver` chain rather than the JSX
 * strategy alone, because chain position is what made the earlier
 * import-binding fix land green while the live graph never moved.
 */
describe("TSCallResolver — wrapper-exported JSX components pin a symbol (bd tea-rags-mcp-ex28m)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ex28m-wrapper-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function writeSource(relPath: string, content: string): void {
    const abs = join(repoRoot, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }

  /** taxdome's real shapes: memo-wrapper, forwardRef-wrapper, and a plain export. */
  function writeCorpus(): void {
    writeSource(
      "src/ui/Modal.tsx",
      [
        `import { memo } from "react";`,
        `function Modal(props: { open: boolean }) {`,
        `  return null;`,
        `}`,
        `const memoized = memo(Modal);`,
        `export { memoized as Modal };`,
        ``,
      ].join("\n"),
    );
    writeSource(
      "src/ui/Layout.tsx",
      [
        `import { forwardRef } from "react";`,
        `function Layout(props: { wide: boolean }) {`,
        `  return null;`,
        `}`,
        `const refForwarded = forwardRef(Layout);`,
        `export { refForwarded as Layout };`,
        ``,
      ].join("\n"),
    );
    writeSource("src/ui/Preloader.tsx", `export function Preloader() {\n  return null;\n}\n`);
    writeSource(
      "src/page.tsx",
      [
        `import { Modal } from "./ui/Modal.js";`, // 1
        `import { Layout } from "./ui/Layout.js";`, // 2
        `import { Preloader } from "./ui/Preloader.js";`, // 3
        ``, // 4
        `export function Page() {`, // 5
        `  return (`, // 6
        `    <Modal open>`, // 7
        `      <Layout wide>`, // 8
        `        <Preloader />`, // 9
        `      </Layout>`, // 10
        `    </Modal>`, // 11
        `  );`, // 12
        `}`, // 13
        ``,
      ].join("\n"),
    );
  }

  /**
   * What the chunker records. Critically it holds `Modal` / `Layout` — the
   * names the components are DECLARED under — and NOT the wrapper bindings
   * `memoized` / `refForwarded`, which is the real corpus's shape.
   */
  function symbolTable(): InMemoryGlobalSymbolTable {
    const table = new InMemoryGlobalSymbolTable();
    const def = (name: string, relPath: string) => ({
      symbolId: name,
      fqName: name,
      shortName: name,
      relPath,
      scope: [] as string[],
    });
    table.upsertFile("src/ui/Modal.tsx", [def("Modal", "src/ui/Modal.tsx")]);
    table.upsertFile("src/ui/Layout.tsx", [def("Layout", "src/ui/Layout.tsx")]);
    table.upsertFile("src/ui/Preloader.tsx", [def("Preloader", "src/ui/Preloader.tsx")]);
    table.upsertFile("src/page.tsx", [def("Page", "src/page.tsx")]);
    return table;
  }

  function pageContext(): CallContext {
    return {
      callerFile: "src/page.tsx",
      callerScope: [],
      imports: [
        { importText: "./ui/Modal.js", startLine: 1, importedNames: ["Modal"], importedBindings: { Modal: "Modal" } },
        {
          importText: "./ui/Layout.js",
          startLine: 2,
          importedNames: ["Layout"],
          importedBindings: { Layout: "Layout" },
        },
        {
          importText: "./ui/Preloader.js",
          startLine: 3,
          importedNames: ["Preloader"],
          importedBindings: { Preloader: "Preloader" },
        },
      ],
      symbolTable: symbolTable(),
    };
  }

  function jsxCall(member: string, startLine: number): CallRef {
    return { callText: `<${member} />`, receiver: null, member, startLine, jsx: true };
  }

  function resolverForRepo(): TSCallResolver {
    return new TSCallResolver({ baseUrl: ".", paths: {} }, "strict", repoRoot);
  }

  it("pins a memo-wrapper-exported component instead of emitting a file-only edge", () => {
    writeCorpus();

    const result = resolverForRepo().resolve(jsxCall("Modal", 7), pageContext());

    // A null targetSymbolId here is what the write path discards — the edge
    // would vanish with no error anywhere.
    expect(result).toEqual({ targetRelPath: "src/ui/Modal.tsx", targetSymbolId: "Modal" });
  });

  it("pins a forwardRef-wrapper-exported component", () => {
    writeCorpus();

    const result = resolverForRepo().resolve(jsxCall("Layout", 8), pageContext());

    expect(result).toEqual({ targetRelPath: "src/ui/Layout.tsx", targetSymbolId: "Layout" });
  });

  it("leaves a plainly-exported component exactly as it was", () => {
    writeCorpus();

    const result = resolverForRepo().resolve(jsxCall("Preloader", 9), pageContext());

    expect(result).toEqual({ targetRelPath: "src/ui/Preloader.tsx", targetSymbolId: "Preloader" });
  });

  it("emits no null-target edge for any tag in the file", () => {
    writeCorpus();

    const resolver = resolverForRepo();
    const results = [
      resolver.resolve(jsxCall("Modal", 7), pageContext()),
      resolver.resolve(jsxCall("Layout", 8), pageContext()),
      resolver.resolve(jsxCall("Preloader", 9), pageContext()),
    ];

    // The whole-file assertion the incident needed: every resolved JSX edge is
    // persistable. On the real ConfirmationModal.tsx this was 1 of 6.
    expect(results.filter((r) => r !== null && r.targetSymbolId === null)).toEqual([]);
    expect(results.every((r) => r !== null)).toBe(true);
  });
});
