/**
 * The non-production path predicate compiled to DuckDB SQL (bd tea-rags-mcp-4p3sb.25):
 * the ontology report scopes `cg_identifiers` with it, the architecture report
 * judges its graph with the JS `buildNonProductionPathFilter`. Parity: evaluated
 * in DuckDB, the SQL agrees with the JS filter on every path of a corpus that
 * hits each declared pattern at the root and at depth, plus the near-misses.
 */
import { DuckDBInstance } from "@duckdb/node-api";
import { describe, expect, it } from "vitest";

import { compileNonProductionPathPredicate } from "../../../../src/core/adapters/duckdb/non-production-path-sql.js";
import {
  buildNonProductionPathFilter,
  installedTestFileConventions,
  NON_PRODUCTION_PATTERNS,
  nonProductionPathPatterns,
  testPathPatterns,
} from "../../../../src/core/infra/file-classification/index.js";

/** The predicate the ontology report compiles from the installed conventions. */
const nonProductionPathSql = compileNonProductionPathPredicate(nonProductionPathPatterns());

/** A concrete spelling of one pattern's single segment: `*` → `foo`, `?` → `q`. */
function sampleSegment(pattern: string): { segment: string; directory: boolean } {
  const directory = pattern.endsWith("/") || pattern.endsWith("/**");
  const segment = pattern
    .replace(/^\*\*\//, "")
    .replace(/\/\*\*$/, "")
    .replace(/\/$/, "")
    .replaceAll("*", "foo")
    .replaceAll("?", "q");
  return { segment, directory };
}

function corpus(): string[] {
  const paths = new Set<string>();
  for (const pattern of [...NON_PRODUCTION_PATTERNS, ...testPathPatterns(installedTestFileConventions()).all]) {
    const { segment, directory } = sampleSegment(pattern);
    const upper = segment.toUpperCase();
    const lower = segment.toLowerCase();
    for (const s of [segment, upper, lower]) {
      paths.add(directory ? `${s}/a.ts` : s);
      paths.add(directory ? `src/deep/${s}/a.ts` : `src/deep/${s}`);
      // As a directory component, and as a near-miss with a suffix / prefix glued on.
      paths.add(`src/${s}/inner.txt`);
      paths.add(`src/${s}x/a.ts`);
      paths.add(`src/x${s}.bak`);
      paths.add(s);
    }
  }
  for (const path of [
    "src/core/domains/ingest/worker-pool.ts",
    "app/models/scriptable.rb",
    "src/scriptsx/a.ts",
    "src/transcripts/reader.ts",
    "src/Latest.java",
    "app/Contest.kt",
    "src/Audit.java",
    "src/FooTEST.java",
    "src/InvoiceTest.java",
    "src/parser_test.cc",
    "src/ParserTest.cc",
    "src/models/invoice_spec.rb",
    "src/test_x/foo.py",
    "src/test_x.py",
    "lib/tasks/billing.rake",
    "bin/tea-rags.ts",
  ]) {
    paths.add(path);
  }
  return [...paths];
}

describe("compileNonProductionPathPredicate over the installed non-production patterns", () => {
  it("agrees with buildNonProductionPathFilter on every corpus path, evaluated in DuckDB", async () => {
    const paths = corpus();
    const connection = await (await DuckDBInstance.create(":memory:")).connect();
    try {
      await connection.run("CREATE TABLE p (rel_path VARCHAR)");
      for (const path of paths) await connection.run("INSERT INTO p VALUES ($1)", [path]);
      const reader = await connection.runAndReadAll(
        `SELECT rel_path, (${nonProductionPathSql("rel_path")}) AS non_production FROM p`,
      );
      const filter = buildNonProductionPathFilter();
      const mismatches = reader
        .getRowObjects()
        .filter((row) => row.non_production !== filter.ignores(row.rel_path as string))
        .map((row) => `${String(row.rel_path)}: sql=${String(row.non_production)}`);
      expect(mismatches).toEqual([]);
      // The corpus exercises both answers.
      expect(paths.filter((path) => filter.ignores(path)).length).toBeGreaterThan(50);
      expect(paths.filter((path) => !filter.ignores(path)).length).toBeGreaterThan(20);
    } finally {
      connection.closeSync();
    }
  });

  it("is constant SQL: no bound parameters, no per-path list", () => {
    const sql = nonProductionPathSql("rel_path");
    // Only `(?i)` carries a `?`: no `?` / `$n` placeholder is left to bind.
    expect(sql.replaceAll("(?i)", "")).not.toMatch(/\?|\$\d/);
    expect(sql).not.toMatch(/ IN \(/);
  });

  it.each([
    ["a negation", "!keep.ts"],
    ["a bracket class", "**/[ab]_test.go"],
    ["a mid-path wildcard", "src/*/x.ts"],
    ["a multi-segment path", "db/schema.rb"],
    ["a root-anchored path", "/scripts/"],
    ["a brace list", "**/*.{ts,js}"],
    ["an escape", "**/a\\*b"],
  ])("refuses %s instead of skipping it", (_label, pattern) => {
    expect(() => compileNonProductionPathPredicate({ caseInsensitive: [pattern], caseSensitive: [] })).toThrow(
      /unsupported/,
    );
  });
});
