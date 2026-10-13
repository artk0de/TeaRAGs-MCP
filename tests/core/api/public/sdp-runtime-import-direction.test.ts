/**
 * SDP direction guard for the api/public layer's RUNTIME imports
 * (bd tea-rags-mcp-89k7k.22).
 *
 * `src/core/api/public/` is the STABLE contract surface (instability 0.05, 35
 * afferent edges). The 2026-10-04 rescan measured it depending on the rest of
 * `src/core/api` (instability 0.93) with delta 0.87 — the largest in the scan,
 * `cycleWithDependents`: the App FACTORY in the stable layer called the
 * unstable internal composition root, and the barrel VALUE-re-exported nine
 * runtime symbols from `api/internal/` and `api/errors.js`.
 *
 * The fix moved assembly OUT of the public layer: `createApp` lives in
 * `api/internal/app-factory.ts` (re-exported for bootstrap through the api
 * root barrel), the input-error vocabulary moved INTO the public layer
 * (`public/errors.ts` — the exception vocabulary IS contract vocabulary), and
 * the pure optimizer-recovery render rules moved to `contracts/`. `AppDeps`
 * — assembly input naming adapters and domain services — followed `createApp`
 * into `app-factory.ts` (k7kmu C1). What remains in `api/public` is the
 * contract: the `App` interface and DTOs. Type-only edges ARE SDP-judged — the
 * component detector has no type-only flag, and `domain-boundaries.md` ("Strict
 * import-direction model") grants no `allowTypeImports` escape hatch — so k7kmu
 * C2 removed the last type re-exports out of `api/internal/` too: the resolver
 * types moved to `contracts/types/registry.ts`, `OptimizerRecoveryOps` left for
 * the api root barrel, and mcp writes against the `SchemaBuilderPort` contract
 * instead of the internal `SchemaBuilder` class.
 *
 * k7kmu C3 finished the purge for DOMAIN re-exports: every runtime symbol the
 * barrel re-exported from `domains/**` (the registry facade's env/replay/
 * backend-resolution functions, `CollectionRegistry`, `QuarantineStore`,
 * `formatWorktreeSeedReport`, the freshness check, the ingest
 * `IndexingAlreadyInProgressError`) left for the api root barrel — the
 * ASSEMBLY surface cli/bootstrap consume — or for `contracts/` when the rule
 * is pure (`PROJECT_NAME_RE`, the worktree seed render). The stable contract
 * layer holds no runtime edge into a domain.
 *
 * This test pins the direction: no file under `src/core/api/public/` may hold
 * a RUNTIME (value) import or re-export whose specifier resolves into
 * `api/internal/**` or `api/errors.js`. A re-export added back through the
 * barrel is a VALUE edge onto the unstable component again — write the
 * consumer against the api root barrel (assembly surface) or move the symbol
 * to its layer-correct home instead.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const PUBLIC_DIR = "src/core/api/public";

function tsFilesUnder(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${entry}`;
    if (statSync(join(ROOT, rel)).isDirectory()) tsFilesUnder(rel, acc);
    else if (entry.endsWith(".ts")) acc.push(rel);
  }
  return acc;
}

interface RuntimeImport {
  /** Value (non-`type`) clause names the statement carries. */
  names: string[];
  specifier: string;
}

/**
 * Named-form import/export statements carrying at least one RUNTIME clause.
 * `import type { A }` / `export type { A }` are erased at compile time and are
 * NOT SDP-judged — they stay legal (0qaht.36). A mixed statement
 * (`import { f, type T }`) is runtime: `f` is a value edge.
 */
function runtimeNamedStatements(text: string): RuntimeImport[] {
  const statements: RuntimeImport[] = [];
  const pattern = /(import|export)\s+(type\s+)?\{([^}]*)\}\s*from\s*"([^"]+)"/g;
  for (const match of text.matchAll(pattern)) {
    const isTypeStatement = match[2] !== undefined;
    const names = match[3]
      .split(",")
      .map((clause) => clause.trim())
      .filter((clause) => clause.length > 0 && !/^type\s+/.test(clause))
      .flatMap((clause) => clause.split(/\s+as\s+/).map((side) => side.trim()));
    if (isTypeStatement || names.length === 0) continue;
    statements.push({ names, specifier: match[4] });
  }
  return statements;
}

/**
 * True when `specifier`, resolved from `fileRel`, lands inside
 * `src/core/api/internal/` or on `src/core/api/errors.js` — the api
 * component's unstable ground outside the public contract layer.
 */
function resolvesIntoUnstableApi(fileRel: string, specifier: string): boolean {
  if (!specifier.startsWith(".")) return false;
  const path = resolveSpecifier(fileRel, specifier);
  return path.startsWith("src/core/api/internal/") || path === "src/core/api/errors.js";
}

/** Repo-relative path a relative `specifier` lands on, resolved from `fileRel`. */
function resolveSpecifier(fileRel: string, specifier: string): string {
  const dir = fileRel.split("/").slice(0, -1).join("/");
  const segments = [...dir.split("/"), ...specifier.split("/")];
  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") resolved.pop();
    else resolved.push(segment);
  }
  return resolved.join("/");
}

/**
 * Specifiers of every RUNTIME module edge in a file, in ANY syntactic form the
 * named-form scanner misses: `export * from`, `export * as ns from`,
 * `import * as ns from`, default imports, side-effect imports and dynamic
 * `import()`. `import type` / `export type` forms are erased and skipped.
 */
function runtimeSpecifiersAnyForm(text: string): string[] {
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const specifiers: string[] = [];
  const staticForm =
    /(?:import|export)\s+(type\s+)?(?:\*(?:\s+as\s+\w+)?|\w+(?:\s*,\s*\{[^}]*\})?|\{[^}]*\})\s*from\s*"([^"]+)"/g;
  for (const match of stripped.matchAll(staticForm)) {
    if (match[1] === undefined) specifiers.push(match[2]);
  }
  for (const match of stripped.matchAll(/(?:^|[\s;])import\s*"([^"]+)"/gm)) specifiers.push(match[1]);
  for (const match of stripped.matchAll(/\bimport\s*\(\s*"([^"]+)"\s*\)/g)) specifiers.push(match[1]);
  return specifiers;
}

describe("api/public holds only the contract — no runtime import from the unstable api component", () => {
  it("no file under src/core/api/public runtime-imports or re-exports from api/internal or api/errors", () => {
    const offenders: string[] = [];
    for (const file of tsFilesUnder(PUBLIC_DIR)) {
      const text = readFileSync(join(ROOT, file), "utf-8");
      for (const statement of runtimeNamedStatements(text)) {
        if (!resolvesIntoUnstableApi(file, statement.specifier)) continue;
        offenders.push(`${file}: ${statement.names.join(", ")} from "${statement.specifier}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no file under src/core/api/public imports or re-exports from api/internal — type-only included (k7kmu C2)", () => {
    const offenders: string[] = [];
    const pattern = /(?:import|export)\s+(?:type\s+)?(?:\{[^}]*\}|\*(?:\s+as\s+\w+)?|\w+)\s*from\s*"([^"]+)"/g;
    for (const file of tsFilesUnder(PUBLIC_DIR)) {
      const text = readFileSync(join(ROOT, file), "utf-8");
      for (const match of text.matchAll(pattern)) {
        const specifier = match[1];
        if (!specifier.startsWith(".")) continue;
        if (!resolveSpecifier(file, specifier).startsWith("src/core/api/internal/")) continue;
        offenders.push(`${file}: "${specifier}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no file under src/core/api/public runtime-imports or re-exports from domains/** (k7kmu C3)", () => {
    const offenders: string[] = [];
    for (const file of tsFilesUnder(PUBLIC_DIR)) {
      const text = readFileSync(join(ROOT, file), "utf-8");
      for (const statement of runtimeNamedStatements(text)) {
        if (!statement.specifier.startsWith(".")) continue;
        if (!resolveSpecifier(file, statement.specifier).startsWith("src/core/domains/")) continue;
        offenders.push(`${file}: ${statement.names.join(", ")} from "${statement.specifier}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no file under src/core/api/public holds ANY runtime edge into domains/** — export *, import * as, default and dynamic import() included (89k7k.40)", () => {
    const offenders: string[] = [];
    for (const file of tsFilesUnder(PUBLIC_DIR)) {
      for (const specifier of runtimeSpecifiersAnyForm(readFileSync(join(ROOT, file), "utf-8"))) {
        if (!specifier.startsWith(".")) continue;
        if (resolveSpecifier(file, specifier).startsWith("src/core/domains/")) {
          offenders.push(`${file}: "${specifier}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the any-form scanner sees the forms the named scanner misses", () => {
    const sample = [
      'export * from "./a.js";',
      'export * as ns from "./b.js";',
      'import * as ns2 from "./c.js";',
      'import dflt from "./d.js";',
      'import dflt2, { x } from "./e.js";',
      'import "./f.js";',
      'const m = await import("./g.js");',
      'import type { T } from "./skip1.js";',
      'export type { T } from "./skip2.js";',
    ].join("\n");
    expect(runtimeSpecifiersAnyForm(sample)).toEqual(
      expect.arrayContaining(["./a.js", "./b.js", "./c.js", "./d.js", "./e.js", "./f.js", "./g.js"]),
    );
    expect(runtimeSpecifiersAnyForm(sample)).not.toContain("./skip1.js");
    expect(runtimeSpecifiersAnyForm(sample)).not.toContain("./skip2.js");
  });

  it("the App factory lives in the composition root, not in the contract layer", () => {
    const contract = readFileSync(join(ROOT, "src/core/api/public/app.ts"), "utf-8");
    expect(contract, "public/app.ts must not define the factory").not.toMatch(/export function createApp/);
    const factory = readFileSync(join(ROOT, "src/core/api/internal/app-factory.ts"), "utf-8");
    expect(factory, "internal/app-factory.ts must define the factory").toMatch(/export function createApp/);
  });
});
