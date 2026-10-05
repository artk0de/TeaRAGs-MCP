/**
 * Import-direction pin for the language kernel leaf (bd tea-rags-mcp-89k7k.23,
 * extended to the residual root machinery by bd tea-rags-mcp-89k7k.29).
 *
 * The SDP rescan measured the language root as a component with dependents in
 * a cycle (dI 0.69): the per-language verticals reached INTO the root's shared
 * machinery (`shared/ecmascript-symbol-lookup.ts`, w5+w3+w2 from the
 * TypeScript resolvers; `cone-dispatch.ts`, w2 from `ts-resolver.ts`) while
 * the root's factory and barrel reach back down into the verticals. The fix
 * promoted both modules into `kernel/` — the stable leaf every vertical may
 * point at — so the vertical→leaf edges keep their direction and the
 * root↔vertical cycle loses its carrying edges.
 *
 * 89k7k.29 extended the same playbook to the residual root machinery with
 * per-language deep consumers: `resolver-chain.ts` (ts w2, ruby w2),
 * `import-file-edges.ts` (ts w1), `external-classifier.ts` (ruby w3), and
 * the frozen `shared/ecmascript-globals.ts` data set — all promoted into
 * `kernel/` after a per-file deps check confirmed the clean-leaf property
 * (contracts-only imports; the globals module imports nothing at all).
 *
 * This test pins the moves: no file under `domains/language/` OUTSIDE the
 * kernel may import a promoted module by its pre-move (or any deep) path — the
 * kernel barrel is the one entry, the contract `kernel/index.ts` documents.
 * Mirrors the mechanism of `tests/core/api/public/sdp-type-import-direction.test.ts`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../../../../");
const LANGUAGE_ROOT = "src/core/domains/language";
const KERNEL_BARREL = `${LANGUAGE_ROOT}/kernel/index.ts`;

function tsFilesUnder(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${entry}`;
    if (statSync(join(ROOT, rel)).isDirectory()) tsFilesUnder(rel, acc);
    else if (entry.endsWith(".ts")) acc.push(rel);
  }
  return acc;
}

/**
 * Specifier suffixes that reach the promoted modules by any path other
 * than the kernel barrel: the pre-move locations (`shared/…`, root-level
 * `cone-dispatch.js` and friends) and a deep `kernel/<file>.js` import alike —
 * the barrel is the documented entry for consumers outside `kernel/`.
 */
const FORBIDDEN_SPECIFIER_SUFFIXES = [
  /\/cone-dispatch\.js$/,
  /\/ecmascript-symbol-lookup\.js$/,
  /\/resolver-chain\.js$/,
  /\/import-file-edges\.js$/,
  /\/external-classifier\.js$/,
  /\/ecmascript-globals\.js$/,
] as const;

interface NamedStatement {
  names: Set<string>;
  specifier: string;
}

/** Named-form import/export statements (`import { A } from "mod"`, `export { A } from "mod"`). */
function namedFromStatements(text: string): NamedStatement[] {
  const statements: NamedStatement[] = [];
  const pattern = /(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s*from\s*"([^"]+)"/g;
  for (const match of text.matchAll(pattern)) {
    const names = new Set<string>();
    for (const clause of match[1].split(",")) {
      const cleaned = clause.trim().replace(/^type\s+/, "");
      if (!cleaned) continue;
      for (const side of cleaned.split(/\s+as\s+/)) names.add(side.trim());
    }
    statements.push({ names, specifier: match[2] });
  }
  return statements;
}

describe("language verticals reach the promoted leaf modules only through the kernel barrel", () => {
  it("no file outside kernel/ imports a promoted module by module path", () => {
    const offenders: string[] = [];
    for (const file of tsFilesUnder(LANGUAGE_ROOT)) {
      if (file.startsWith(`${LANGUAGE_ROOT}/kernel/`)) continue;
      for (const statement of namedFromStatements(readFileSync(join(ROOT, file), "utf-8"))) {
        if (FORBIDDEN_SPECIFIER_SUFFIXES.some((suffix) => suffix.test(statement.specifier))) {
          offenders.push(`${file}: "${statement.specifier}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the kernel barrel exports both promoted modules' public API", () => {
    const text = readFileSync(join(ROOT, KERNEL_BARREL), "utf-8");
    expect(text, "ConeDispatchResolver must be re-exported from ./cone-dispatch.js").toMatch(
      /export\s*\{[^}]*\bConeDispatchResolver\b[^}]*\}\s*from\s*"\.\/cone-dispatch\.js"/,
    );
    expect(text, "the ECMAScript family lookup API must be re-exported from ./ecmascript-symbol-lookup.js").toMatch(
      /export\s*\{[^}]*\blookupEcmascriptSymbolsByShortName\b[^}]*\}\s*from\s*"\.\/ecmascript-symbol-lookup\.js"/,
    );
  });

  it("the kernel barrel exports the 89k7k.29 residual-machinery modules' public API", () => {
    const text = readFileSync(join(ROOT, KERNEL_BARREL), "utf-8");
    expect(text, "the resolver chain must be re-exported from ./resolver-chain.js").toMatch(
      /export\s*\{[^}]*\bresolveViaChain\b[^}]*\}\s*from\s*"\.\/resolver-chain\.js"/,
    );
    expect(text, "the import→file-edge engine must be re-exported from ./import-file-edges.js").toMatch(
      /export\s*\{[^}]*\bresolveImportFileEdges\b[^}]*\}\s*from\s*"\.\/import-file-edges\.js"/,
    );
    expect(text, "ExternalCallClassifier must be re-exported from ./external-classifier.js").toMatch(
      /export\s*\{[^}]*\bExternalCallClassifier\b[^}]*\}\s*from\s*"\.\/external-classifier\.js"/,
    );
    expect(text, "the frozen ECMAScript global vocabulary must be re-exported from ./ecmascript-globals.js").toMatch(
      /export\s*\{[^}]*\bECMASCRIPT_GLOBALS\b[^}]*\}\s*from\s*"\.\/ecmascript-globals\.js"/,
    );
  });
});
