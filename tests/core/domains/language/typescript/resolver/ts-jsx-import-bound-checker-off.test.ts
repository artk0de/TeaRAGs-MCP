import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CallContext, CallRef, ImportRef } from "../../../../../../src/core/contracts/types/codegraph.js";
import { TSCallResolver } from "../../../../../../src/core/domains/language/typescript/resolver/ts-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

/**
 * bd tea-rags-mcp-ex28m — an import-bound JSX tag resolves through its IMPORT
 * with no type checker available. CHARACTERIZATION guard, and read the scope
 * note below before treating it as the incident's regression test.
 *
 * Context. On 2026-08-17 taxdome's TS edges stood at 58,602 against a ~99,583
 * baseline, and the 13:13 repair pass re-extracted 482 TS files with NO
 * `ts.Program` (REPAIR_PASS→REPAIR_FINALIZE_START was 205ms, where a taxdome
 * Program build is minutes). The suspected mechanism was that a checker-off JSX
 * tag falls through to the short-name passes, where `pickSingleCandidate(strict)`
 * returns null at N>1 and every tag naming a component the corpus declares more
 * than once — `Button`, `Modal`, `Layout` — silently loses its edge.
 *
 * The plain form of that hypothesis is FALSE, and most of these cases prove it:
 * with the checker off and the specifier mapping straight to a FILE, the chain
 * already resolved the tag correctly, namesakes and all — `importedCallee`
 * answers from `ImportRef.importedBindings` long before any short-name pass.
 * Those cases passed against unmodified `main` and are kept as checker-off
 * CHARACTERIZATION guards — the real checker-off path is a heap-admission
 * refusal or `CODEGRAPH_TS_TYPECHECKER=0`, NOT the repair leg, which is not
 * checker-off by design: the 205ms above was the dispatch of 482 unwalkable
 * files, not a TS extraction (bd tea-rags-mcp-sz1y0, spike gl96z).
 *
 * The gap was one hop further in: a BARREL specifier. `from 'ui-kit'` maps to
 * `ui-kit/index.ts`, which declares nothing itself, so the answer depends on
 * following its re-export — and `reexportOriginFile` did that by looking the
 * short name up GLOBALLY, then refusing under strict because two packages
 * declare `Button`. The barrel's own `export { Button } from
 * 'ui-kit/components/Button/Button'` was never consulted. Measured on the real
 * `ConfirmationModal.tsx` with the production walker, checker off: 4 edges and
 * 2 dropped, the drops being `<Button>` twice, while `<Modal>`, `<Layout>` and
 * `<Preloader>` — each declared once — resolved beside them. After the fix:
 * 6 edges, 0 dropped. That is the incident's split exactly, and the barrel case
 * below is the red test that drove the fix.
 *
 * The fixture is a REAL directory tree because import mapping probes the real
 * filesystem (`createProjectFileProbe`), and it declares tsconfig `paths`
 * because a non-relative specifier resolves ONLY through them — without either,
 * every specifier looks external and these cases pass for the wrong reason.
 */
describe("TSCallResolver — import-bound JSX tags with the checker OFF (bd tea-rags-mcp-ex28m)", () => {
  let repoRoot: string;
  let previousTypecheckerEnv: string | undefined;

  const UI_KIT_BUTTON = "app/javascript/ui-kit/components/Button/Button.tsx";
  const REACT_APP_BUTTON = "app/javascript/react-app/components/Button/Button.tsx";
  const PROTOTYPE_BUTTON = "app/javascript/prototypes/gallery/Button/Button.tsx";
  const PRELOADER = "app/javascript/ui-kit/components/Preloader/Preloader.tsx";
  const CALLER = "app/javascript/react-app/components/ConfirmationModal/ConfirmationModal.tsx";
  const UI_KIT_BARREL = "app/javascript/ui-kit/index.ts";
  const UI_KIT_LEGACY_BUTTON = "app/javascript/ui-kit/legacy/Button/Button.tsx";

  /**
   * taxdome's own alias shape — a non-relative specifier resolves ONLY via
   * `paths`, and the catch-all is what maps a bare barrel specifier like
   * `ui-kit` (the explicit `ui-kit/*` pattern requires a subpath and would
   * leave the barrel unmapped).
   */
  const TSCONFIG = {
    baseUrl: ".",
    paths: {
      "ui-kit/*": ["app/javascript/ui-kit/*"],
      "react-app/*": ["app/javascript/react-app/*"],
      "prototypes/*": ["app/javascript/prototypes/*"],
      "*": ["app/javascript/*"],
    },
  };

  beforeAll(() => {
    // The repair pass ran with no Program at all. `CODEGRAPH_TS_TYPECHECKER=0`
    // reproduces that deterministically: the cache is never constructed, so the
    // JSX checker pass is absent from the chain entirely.
    previousTypecheckerEnv = process.env.CODEGRAPH_TS_TYPECHECKER;
    process.env.CODEGRAPH_TS_TYPECHECKER = "0";
    repoRoot = mkdtempSync(join(tmpdir(), "ex28m-jsx-"));
    for (const relPath of [
      UI_KIT_BUTTON,
      REACT_APP_BUTTON,
      PROTOTYPE_BUTTON,
      PRELOADER,
      CALLER,
      UI_KIT_BARREL,
      UI_KIT_LEGACY_BUTTON,
    ]) {
      const absolute = join(repoRoot, relPath);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, "export const X = 1;\n");
    }
  });

  afterAll(() => {
    if (previousTypecheckerEnv === undefined) delete process.env.CODEGRAPH_TS_TYPECHECKER;
    else process.env.CODEGRAPH_TS_TYPECHECKER = previousTypecheckerEnv;
    rmSync(repoRoot, { recursive: true, force: true });
  });

  /** No program cache — exactly the repair-pass condition. */
  function resolverWithoutChecker(): TSCallResolver {
    const resolver = new TSCallResolver(TSCONFIG, "strict", repoRoot);
    expect(resolver.programCache, "fixture must exercise the checker-OFF chain").toBeNull();
    return resolver;
  }

  function jsxTag(member: string, startLine = 12): CallRef {
    return { callText: `<${member} />`, receiver: null, member, startLine, jsx: true };
  }

  function contextFor(imports: ImportRef[], symbolTable: InMemoryGlobalSymbolTable, caller = CALLER): CallContext {
    return { callerFile: caller, callerScope: [], imports, symbolTable };
  }

  function tableWith(...relPaths: string[]): InMemoryGlobalSymbolTable {
    const symbolTable = new InMemoryGlobalSymbolTable();
    for (const relPath of relPaths) {
      const name = relPath.split("/").pop()!.replace(".tsx", "");
      symbolTable.upsertFile(relPath, [{ symbolId: name, fqName: name, shortName: name, relPath, scope: [] }]);
    }
    return symbolTable;
  }

  function importOf(importText: string, local: string, exported: string): ImportRef {
    return { importText, startLine: 3, importedNames: [local], importedBindings: { [local]: exported } };
  }

  it("resolves a namesake component to the file the caller IMPORTED", () => {
    const result = resolverWithoutChecker().resolve(
      jsxTag("Button"),
      contextFor(
        [importOf("ui-kit/components/Button/Button", "Button", "Button")],
        tableWith(UI_KIT_BUTTON, REACT_APP_BUTTON, PROTOTYPE_BUTTON),
      ),
    );

    expect(result).toEqual({ targetRelPath: UI_KIT_BUTTON, targetSymbolId: "Button" });
  });

  it("picks the OTHER namesake when that is the one imported", () => {
    // Same three declarations, a different import — the import alone decides.
    const result = resolverWithoutChecker().resolve(
      jsxTag("Button"),
      contextFor(
        [importOf("react-app/components/Button/Button", "Button", "Button")],
        tableWith(UI_KIT_BUTTON, REACT_APP_BUTTON, PROTOTYPE_BUTTON),
      ),
    );

    expect(result).toEqual({ targetRelPath: REACT_APP_BUTTON, targetSymbolId: "Button" });
  });

  it("resolves a namesake tag imported under an ALIAS to the exported declaration", () => {
    const result = resolverWithoutChecker().resolve(
      jsxTag("UiButton"),
      contextFor(
        [importOf("ui-kit/components/Button/Button", "UiButton", "Button")],
        tableWith(UI_KIT_BUTTON, REACT_APP_BUTTON, PROTOTYPE_BUTTON),
      ),
    );

    expect(result).toEqual({ targetRelPath: UI_KIT_BUTTON, targetSymbolId: "Button" });
  });

  it("keeps resolving a UNIQUELY-named imported tag — the survivors in the incident", () => {
    const result = resolverWithoutChecker().resolve(
      jsxTag("Preloader"),
      contextFor([importOf("ui-kit/components/Preloader/Preloader", "Preloader", "Preloader")], tableWith(PRELOADER)),
    );

    expect(result).toEqual({ targetRelPath: PRELOADER, targetSymbolId: "Preloader" });
  });

  it("follows a BARREL re-export to the namesake inside the barrel's own package", () => {
    // THE INCIDENT, reduced. taxdome's `ui-kit/index.ts` carries
    // `export { Button } from 'ui-kit/components/Button/Button'`, so the barrel
    // states which of the two `Button` files it re-exports. `reexportOriginFile`
    // ignored that and looked the short name up GLOBALLY, then refused under
    // strict because two files declare it — the barrel's own package boundary
    // was never consulted. Verified against the real file with the production
    // walker: `<Button>` twice -> NO EDGE, while every uniquely-named tag beside
    // it resolved.
    const result = resolverWithoutChecker().resolve(
      jsxTag("Button"),
      contextFor([importOf("ui-kit", "Button", "Button")], tableWith(UI_KIT_BUTTON, REACT_APP_BUTTON)),
    );

    expect(result).toEqual({ targetRelPath: UI_KIT_BUTTON, targetSymbolId: "Button" });
  });

  it("keeps refusing when the barrel's own package declares the name twice", () => {
    // Narrowing to the barrel's package is EVIDENCE, not a preference. Two
    // candidates inside ui-kit leave the barrel unable to say which, so the
    // refusal stands rather than degrading into a coin flip.
    const result = resolverWithoutChecker().resolve(
      jsxTag("Button"),
      contextFor([importOf("ui-kit", "Button", "Button")], tableWith(UI_KIT_BUTTON, UI_KIT_LEGACY_BUTTON)),
    );

    expect(result).toBeNull();
  });

  it("still declines a namesake tag the caller did NOT import — no import, no authority", () => {
    const result = resolverWithoutChecker().resolve(
      jsxTag("Button"),
      contextFor([], tableWith(UI_KIT_BUTTON, REACT_APP_BUTTON, PROTOTYPE_BUTTON)),
    );

    // Ambiguous by short name with nothing to disambiguate it. Refusing is
    // correct — the import is what confers authority, and there is none.
    expect(result).toBeNull();
  });

  it("does not follow an import that maps outside the project", () => {
    const result = resolverWithoutChecker().resolve(
      jsxTag("Button"),
      contextFor([importOf("@mui/material", "Button", "Button")], tableWith(UI_KIT_BUTTON, REACT_APP_BUTTON)),
    );

    // An npm package sharing a component name must not fabricate a project edge.
    expect(result).toBeNull();
  });
});
