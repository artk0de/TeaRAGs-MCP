/**
 * Behaviour parity for moving the per-language test-file masks out of infra into
 * `domains/language` (bd tea-rags-mcp-vjz6s). The baseline fixture was captured
 * from the classifier BEFORE the move, when `TEST_PATTERNS_BY_LANGUAGE` still
 * lived in `infra/file-classification/patterns.ts`: a corpus hitting every
 * declared test and tooling pattern at the root, at depth, as a directory
 * component and as a near-miss, in three casings, plus hand-picked PascalCase,
 * mixed-case and scope-only cases — and, per path, what `classify().isTest`,
 * `buildTestPathFilter`, `buildNonProductionPathFilter` and the DuckDB
 * non-production predicate answered, with `getDefaultTestPaths` per language.
 *
 * The same corpus must get the same answers from the injected conventions.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DuckDBInstance } from "@duckdb/node-api";
import { describe, expect, it } from "vitest";

import { compileNonProductionPathPredicate } from "../../../../src/core/adapters/duckdb/non-production-path-sql.js";
import { languageTestFileConventions } from "../../../../src/core/domains/language/capability/native.js";
import {
  buildNonProductionPathFilter,
  buildTestPathFilter,
  classify,
  nonProductionPathPatterns,
} from "../../../../src/core/infra/file-classification/index.js";
import { isTestPath } from "../../../../src/core/infra/scope-detection.js";

interface ClassificationBaseline {
  corpus: string[];
  testPaths: string[];
  testFilterPaths: string[];
  nonProductionPaths: string[];
  nonProductionSqlPaths: string[];
  defaultTestPathsByLanguage: Record<string, string[]>;
}

const BASELINE = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures/test-path-classification-baseline.json"), "utf8"),
) as ClassificationBaseline;

describe("test-path classification parity across the domains/language relocation (bd tea-rags-mcp-vjz6s)", () => {
  const conventions = languageTestFileConventions();

  it("classify().isTest answers the baseline on every corpus path", () => {
    expect(BASELINE.corpus.filter((p) => classify(p).isTest)).toEqual(BASELINE.testPaths);
  });

  it("buildTestPathFilter over the injected conventions answers the baseline", () => {
    const filter = buildTestPathFilter(conventions);
    expect(BASELINE.corpus.filter((p) => filter.ignores(p))).toEqual(BASELINE.testFilterPaths);
  });

  it("buildNonProductionPathFilter over the injected conventions answers the baseline", () => {
    const filter = buildNonProductionPathFilter(conventions);
    expect(BASELINE.corpus.filter((p) => filter.ignores(p))).toEqual(BASELINE.nonProductionPaths);
  });

  it("the DuckDB non-production predicate answers the baseline, evaluated in DuckDB", async () => {
    const predicate = compileNonProductionPathPredicate(nonProductionPathPatterns(conventions));
    const instance = await DuckDBInstance.create(":memory:");
    const connection = await instance.connect();
    try {
      await connection.run("CREATE TABLE p (rel_path VARCHAR)");
      const appender = await connection.createAppender("p");
      for (const path of BASELINE.corpus) {
        appender.appendVarchar(path);
        appender.endRow();
      }
      appender.closeSync();
      const reader = await connection.runAndReadAll(
        `SELECT rel_path FROM p WHERE ${predicate("rel_path")} ORDER BY rel_path`,
      );
      const matched = reader
        .getRowObjects()
        .map((row) => row.rel_path as string)
        .sort();
      expect(matched).toEqual(BASELINE.nonProductionSqlPaths);
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
  });

  it("scope detection's isTestPath answers the classifier baseline for every language, vertical or not", () => {
    // The per-language glob lists the baseline also recorded
    // (`defaultTestPathsByLanguage`) are retired: scope detection now asks the
    // classifier, so its answer IS `testPaths` (bd tea-rags-mcp-jl3ff).
    for (const language of Object.keys(BASELINE.defaultTestPathsByLanguage)) {
      expect(
        BASELINE.corpus.filter((p) => isTestPath(p, language)),
        language,
      ).toEqual(BASELINE.testPaths);
    }
  });
});
