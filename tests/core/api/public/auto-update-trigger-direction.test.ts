/**
 * Direction pin for the `McpAutoUpdateTrigger` port (bd tea-rags-mcp-k7kmu
 * C13).
 *
 * The trigger type is contract vocabulary: `core/api/public/` owns it
 * (`auto-update-trigger.ts`), bootstrap's `mcp-hint.ts` implements it, and
 * the mcp search tools consume it structurally. Before C13 the definition
 * lived in `mcp/tools/explore.ts`, so bootstrap's implementation had to
 * import the type back out of `mcp/**` — the S14 bootstrap→mcp edge for this
 * name (the registerAllTools composition edge is a separate, sanctioned
 * finding and not this pin's subject).
 *
 * This test pins the direction: every file under `src/` and `tests/` that
 * imports `McpAutoUpdateTrigger` must take it from `core/api/public` — no
 * import of the type from `mcp/**` or `bootstrap/**` anywhere outside those
 * layers' own use of the stable contract.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../../..");
const PUBLIC_DIR = "src/core/api/public";

function tsFilesUnder(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${entry}`;
    if (statSync(join(ROOT, rel)).isDirectory()) tsFilesUnder(rel, acc);
    else if (entry.endsWith(".ts")) acc.push(rel);
  }
  return acc;
}

/** Named-form import/export statements: clause list + specifier. */
const NAMED_STATEMENT = /(import|export)\s+(?:type\s+)?\{([^}]*)\}\s*from\s*"([^"]+)"/g;

function clauseNames(clauses: string): string[] {
  return clauses
    .split(",")
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0)
    .map((clause) => clause.replace(/^type\s+/, ""))
    .flatMap((clause) => clause.split(/\s+as\s+/).map((side) => side.trim()));
}

/** True when a relative specifier, resolved from `fromRel`, lands in the public layer. */
function resolvesIntoPublicDir(fromRel: string, specifier: string): boolean {
  if (!specifier.startsWith(".")) return false;
  const rel = relative(ROOT, join(dirname(join(ROOT, fromRel)), specifier));
  return rel.startsWith(`${PUBLIC_DIR}/`);
}

describe("McpAutoUpdateTrigger direction pin (k7kmu C13)", () => {
  it("the port lives in api/public and the barrel re-exports it", () => {
    expect(existsSync(join(ROOT, PUBLIC_DIR, "auto-update-trigger.ts"))).toBe(true);
    const barrel = readFileSync(join(ROOT, `${PUBLIC_DIR}/index.ts`), "utf8");
    expect(barrel).toMatch(/export type \{ McpAutoUpdateTrigger \} from "\.\/auto-update-trigger\.js"/);
  });

  it("every import of the type outside api/public resolves into core/api/public", () => {
    const violations: string[] = [];
    for (const file of [...tsFilesUnder("src"), ...tsFilesUnder("tests")]) {
      const text = readFileSync(join(ROOT, file), "utf8");
      for (const match of text.matchAll(NAMED_STATEMENT)) {
        if (!clauseNames(match[2]).includes("McpAutoUpdateTrigger")) continue;
        if (!resolvesIntoPublicDir(file, match[3])) violations.push(`${file} -> "${match[3]}"`);
      }
    }
    expect(violations).toEqual([]);
  });
});
