/**
 * Facade-direction guard for the cli files that reach `bootstrap/config`
 * (bd tea-rags-mcp-52hvq).
 *
 * Every cli consumer of the config module must import it through the
 * `bootstrap/config/index.ts` barrel — the module's facade — not past it into
 * individual config files. The concrete offender this pins was
 * `resolveRegistryEnvCodeDefaults`: eleven cli files deep-imported
 * `registry-env-code-defaults.js` while the barrel was already the surface the
 * same files used for `parseAppConfig`. The resolver belongs on that surface —
 * it is the injected `envCodeDefaults` provider every `CollectionRegistry` a
 * cli command opens receives, so it is config public API by consumption.
 *
 * The assert is scoped to the files the bead repointed; other cli files join
 * the list as they touch the config module. Mechanism mirrors
 * `tests/cli/composition-actor-import-direction.test.ts` (same
 * runtimeNamedStatements / resolveFrom pair): `import type` clauses are erased
 * at compile time and are not judged.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** The cli files the bead repointed onto the config barrel. */
const CONFIG_CONSUMING_CLI_FILES: readonly string[] = [
  "src/cli/completion.ts",
  "src/cli/registry-resolver.ts",
  "src/cli/prime/run-prime.ts",
  "src/cli/call/project-env.ts",
  "src/cli/commands/project.ts",
  "src/cli/commands/projects.ts",
  "src/cli/commands/qdrant.ts",
  "src/cli/commands/worktree.ts",
  "src/cli/commands/index-codebase.ts",
  "src/cli/commands/tune.ts",
  "src/cli/commands/doctor.ts",
];

interface RuntimeImport {
  names: string[];
  specifier: string;
}

/** Named-form import statements carrying at least one RUNTIME clause (`import type` is erased, not an edge). */
function runtimeNamedStatements(text: string): RuntimeImport[] {
  const statements: RuntimeImport[] = [];
  const pattern = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*"([^"]+)"/g;
  for (const match of text.matchAll(pattern)) {
    const isTypeStatement = match[1] !== undefined;
    const names = match[2]
      .split(",")
      .map((clause) => clause.trim())
      .filter((clause) => clause.length > 0 && !/^type\s+/.test(clause));
    if (isTypeStatement || names.length === 0) continue;
    statements.push({ names, specifier: match[3] });
  }
  return statements;
}

/** Resolve a relative specifier from `fileRel` to a repo-relative module path, extension-normalized. */
function resolveFrom(fileRel: string, specifier: string): string {
  if (!specifier.startsWith(".")) return specifier;
  const segments = [...fileRel.split("/").slice(0, -1), ...specifier.split("/")];
  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") resolved.pop();
    else resolved.push(segment);
  }
  const joined = resolved.join("/");
  return joined.replace(/\.js$/, ".ts");
}

describe("cli imports bootstrap/config through the facade barrel, not past it", () => {
  it("holds no runtime import resolving into bootstrap/config/** except the barrel itself", () => {
    const offenders: string[] = [];
    for (const file of CONFIG_CONSUMING_CLI_FILES) {
      const text = readFileSync(join(ROOT, file), "utf-8");
      for (const statement of runtimeNamedStatements(text)) {
        const resolved = resolveFrom(file, statement.specifier);
        if (!resolved.startsWith("src/bootstrap/config/")) continue;
        if (resolved === "src/bootstrap/config/index.ts") continue;
        offenders.push(`${file}: ${statement.names.join(", ")} from "${statement.specifier}"`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
