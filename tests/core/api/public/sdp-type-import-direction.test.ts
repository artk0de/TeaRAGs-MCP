/**
 * SDP direction guard for the stable layers' type vocabulary
 * (bd tea-rags-mcp-0qaht.36).
 *
 * `src/core/api/public/` and `src/bootstrap/` sit on the STABLE side of the
 * import graph, so a type-only dependency on volatile domain internals is the
 * wrong direction even when it costs nothing at runtime (callWeight 0). The
 * fix measured on 2026-10-04 relocated the registry vocabulary the public
 * barrel re-exports into `contracts/types/registry.ts` — the one layer every
 * component may depend on — and moved the worktree seed-report re-export
 * behind the worktree domain facade.
 *
 * This test pins both: the relocated names must never again be imported from
 * a `domains/**` (or `mcp/**`) path inside the stable layers, and the two
 * specific deep paths the bead eliminated must stay gone.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../../..");

/**
 * Registry vocabulary whose definitions moved into
 * `src/core/contracts/types/registry.ts`. The registry domain modules
 * (`env-groups.ts`, `env-resolution.ts`, `qdrant-backend-resolution.ts`,
 * `errors.ts`) re-export them unchanged for their own consumers.
 */
const RELOCATED_REGISTRY_TYPES = [
  "EnvConsequence",
  "RegistryEnvGroup",
  "RegistryLookup",
  "RegistryQdrantBackend",
  "RegistryQdrantBackendClaim",
] as const;

/** Names api/public/index.ts re-exports to cli/mcp consumers. */
const REEXPORTED_REGISTRY_TYPES = [
  "RegistryEnvGroup",
  "RegistryLookup",
  "RegistryQdrantBackend",
  "RegistryQdrantBackendClaim",
] as const;

const STABLE_LAYER_DIRS = ["src/core/api/public", "src/bootstrap"] as const;

function tsFilesUnder(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${entry}`;
    if (statSync(join(ROOT, rel)).isDirectory()) tsFilesUnder(rel, acc);
    else if (entry.endsWith(".ts")) acc.push(rel);
  }
  return acc;
}

interface NamedImport {
  /** Imported/exported names, both sides of an `as` rename included. */
  names: Set<string>;
  specifier: string;
}

/** Named-form import/export statements (`import { A, type B } from "mod"`). */
function namedImportStatements(text: string): NamedImport[] {
  const statements: NamedImport[] = [];
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

describe("stable layers import relocated types from contracts, not domain internals", () => {
  it("api/public and bootstrap never import the relocated registry types from domains/** or mcp/**", () => {
    const offenders: string[] = [];
    for (const dir of STABLE_LAYER_DIRS) {
      for (const file of tsFilesUnder(dir)) {
        const text = readFileSync(join(ROOT, file), "utf-8");
        for (const statement of namedImportStatements(text)) {
          if (!/\/(?:domains|mcp)\//.test(statement.specifier)) continue;
          const hits = RELOCATED_REGISTRY_TYPES.filter((name) => statement.names.has(name));
          if (hits.length > 0) {
            offenders.push(`${file}: ${hits.join(", ")} imported from "${statement.specifier}"`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("api/public/index.ts re-exports the relocated registry types from contracts/types/registry.ts", () => {
    const text = readFileSync(join(ROOT, "src/core/api/public/index.ts"), "utf-8");
    for (const name of REEXPORTED_REGISTRY_TYPES) {
      const fromContracts = new RegExp(`\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*"[^"]*contracts/types/registry\\.js"`);
      expect(text, `${name} must be re-exported from contracts/types/registry.js`).toMatch(fromContracts);
    }
  });

  it("api/public reaches the worktree seed report through the worktree facade, not the deep module", () => {
    for (const file of tsFilesUnder("src/core/api/public")) {
      const text = readFileSync(join(ROOT, file), "utf-8");
      expect(text, `${file} must not deep-import worktree-seed-report.js`).not.toMatch(
        /from\s+"[^"]*domains\/maintenance\/worktree\/worktree-seed-report\.js"/,
      );
    }
  });
});
