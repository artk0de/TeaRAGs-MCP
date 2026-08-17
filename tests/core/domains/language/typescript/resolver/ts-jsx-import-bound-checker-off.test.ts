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
 * WHAT THESE CASES ACTUALLY ESTABLISH: with the checker off and the import
 * MAPPABLE, the chain already resolves the tag correctly, namesakes and all —
 * `importedCallee` answers from `ImportRef.importedBindings` before the
 * short-name passes ever run. Every case here passed on first execution against
 * unmodified `main`; none of them was ever red. So the plain "checker-off drops
 * import-bound JSX tags" hypothesis is FALSE as stated, and whatever cost
 * taxdome its edges lies in a narrower gap not reproduced here — the leading
 * remaining candidate being a barrel specifier (`from 'ui-kit'`) whose
 * re-export origin cannot be followed, which would leave exactly the observed
 * split: unique names resolved by the short-name pass, namesakes refused.
 *
 * They are kept because the behaviour is load-bearing and nothing else pinned
 * it: the repair and recompute legs run checker-off by design, so an import
 * that stops being authoritative there would reintroduce precisely this class
 * of silent loss.
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

  /** taxdome's own alias shape — a non-relative specifier resolves only via `paths`. */
  const TSCONFIG = {
    baseUrl: ".",
    paths: {
      "ui-kit/*": ["app/javascript/ui-kit/*"],
      "react-app/*": ["app/javascript/react-app/*"],
      "prototypes/*": ["app/javascript/prototypes/*"],
    },
  };

  beforeAll(() => {
    // The repair pass ran with no Program at all. `CODEGRAPH_TS_TYPECHECKER=0`
    // reproduces that deterministically: the cache is never constructed, so the
    // JSX checker pass is absent from the chain entirely.
    previousTypecheckerEnv = process.env.CODEGRAPH_TS_TYPECHECKER;
    process.env.CODEGRAPH_TS_TYPECHECKER = "0";
    repoRoot = mkdtempSync(join(tmpdir(), "ex28m-jsx-"));
    for (const relPath of [UI_KIT_BUTTON, REACT_APP_BUTTON, PROTOTYPE_BUTTON, PRELOADER, CALLER]) {
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
