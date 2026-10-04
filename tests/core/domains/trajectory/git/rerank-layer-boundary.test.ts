/**
 * Pins the git trajectory's layering against its rerank/derived-signals
 * subtree (bd tea-rags-mcp-nz15d).
 *
 * The knot that motivated this file: `git/age-derivation.ts` deep-imported
 * `rerank/derived-signals/helpers.ts` for the payload accessors while
 * `age.ts` / `recency.ts` imported back — a layering knot (directory cycle)
 * plus a leaking-abstraction internal reach, since the imported names are
 * not on the derived-signals facade. The accessors moved git-side
 * (`git/infra/payload-accessors.ts`); this test holds the boundary:
 *
 *   - git code OUTSIDE the rerank layer reaches derived-signals only through
 *     its `index.js` facade (the provider's `gitDerivedSignals`
 *     registration), never a deep file,
 *   - and the correct direction stays: derived signals consume the
 *     trajectory's age derivation (`age-derivation.ts`), not a copy.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const GIT_DIR = fileURLToPath(new URL("../../../../../src/core/domains/trajectory/git", import.meta.url));

/** Every .ts file under git/, relative to it. The rerank layer is out of scope. */
function listGitFiles(dir: string, prefix = ""): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === "rerank") continue;
      files.push(...listGitFiles(join(dir, entry.name), `${prefix}${entry.name}/`));
    } else if (entry.name.endsWith(".ts")) {
      files.push(`${prefix}${entry.name}`);
    }
  }
  return files;
}

/** Static import / re-export specifiers of a module's source text. */
function importSpecifiers(text: string): string[] {
  return [...text.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)].map((m) => m[1]);
}

describe("git trajectory ↔ rerank/derived-signals boundary", () => {
  it("git code outside the rerank layer reaches derived-signals only through its facade", () => {
    const violations: string[] = [];
    for (const rel of listGitFiles(GIT_DIR)) {
      for (const spec of importSpecifiers(readFileSync(join(GIT_DIR, rel), "utf8"))) {
        if (!spec.includes("rerank/derived-signals")) continue;
        if (spec.endsWith("rerank/derived-signals/index.js")) continue;
        violations.push(`${rel}: ${spec}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("derived signals consume the trajectory's age derivation, not a copy", () => {
    for (const signal of ["age.ts", "recency.ts"]) {
      const text = readFileSync(join(GIT_DIR, "rerank/derived-signals", signal), "utf8");
      const derivesAge = importSpecifiers(text).some((s) => s.endsWith("/age-derivation.js"));
      expect(derivesAge, `${signal} imports age-derivation`).toBe(true);
    }
  });
});
