import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Follow actual runtime imports/re-exports; type-only contracts cannot initialize a backend. */
function runtimeDependencies(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(resolve(ROOT, file), "utf8"), ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  for (const node of source.statements) {
    if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) continue;
    if (!node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier)) continue;
    if (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly) continue;
    if (ts.isExportDeclaration(node) && node.isTypeOnly) continue;
    const clause = ts.isImportDeclaration(node) ? node.importClause?.namedBindings : node.exportClause;
    if (
      clause &&
      (ts.isNamedImports(clause) || ts.isNamedExports(clause)) &&
      clause.elements.length > 0 &&
      clause.elements.every((part) => part.isTypeOnly) &&
      !(ts.isImportDeclaration(node) && node.importClause?.name)
    ) {
      continue;
    }
    const specifier = node.moduleSpecifier.text;
    if (!specifier.startsWith(".")) {
      out.push(specifier);
      continue;
    }
    const target = resolve(dirname(resolve(ROOT, file)), specifier).replace(/\.js$/, ".ts");
    if (existsSync(target)) out.push(target.slice(ROOT.length + 1));
  }
  return out;
}

describe("agent prime runtime import boundary", () => {
  it("gets assembly values and path policy through bootstrap rather than importing core assembly or config leaves", () => {
    const direct = runtimeDependencies("src/cli/commands/prime-agent.ts");
    expect(direct.filter((file) => file.startsWith("src/core/api/entry-points/"))).toEqual([]);
    expect(direct).not.toContain("src/bootstrap/config/paths.ts");
  });
  it("cannot load server/bootstrap/schema or embedded-daemon code to print registry addresses", () => {
    const forbidden = new Set([
      "src/core/api/index.ts",
      "src/bootstrap/factory.ts",
      "src/bootstrap/config/schemas.ts",
      "src/bootstrap/transport/in-process-session.ts",
      "src/core/adapters/qdrant/embedded/daemon.ts",
      "src/core/adapters/duckdb/daemon/entry.ts",
    ]);
    const seen = new Set<string>();
    const violations: string[] = [];
    const visit = (file: string, chain: string[]): void => {
      if (seen.has(file)) return;
      seen.add(file);
      if (forbidden.has(file) || file.startsWith("@modelcontextprotocol/")) {
        violations.push([...chain, file].join(" → "));
        return;
      }
      if (!file.startsWith("src/")) return;
      for (const next of runtimeDependencies(file)) visit(next, [...chain, file]);
    };
    visit("src/cli/commands/prime-agent.ts", []);
    expect(violations).toEqual([]);
  });
});
