/**
 * The chunk-owner change routes an already-indexed project to a codegraph
 * recompute (bd tea-rags-mcp-9i2ow).
 *
 * `codegraph.symbols.chunk.*` already on disk was written by two writers that
 * disagreed about which symbol owns a chunk, and the payload heal only reaches
 * symbols whose signals MOVE — so nothing short of a recompute rewrites the
 * rest. The change also adds `cg_symbols.start_line/end_line` (migration 024),
 * which only a walk fills. Both are shared across languages, so the stamp that
 * says so is `sharedVersions.codegraphSchema`, and the drift report must turn an
 * index stamped before it into `--force-enrichments codegraph` with no
 * `--languages` narrowing.
 */

import { describe, expect, it } from "vitest";

import { resolveLanguageCodeVersions } from "../../../../../src/core/domains/language/capability/versions.js";
import { LanguageFactory } from "../../../../../src/core/domains/language/factory.js";
import { SHARED_LANGUAGE } from "../../../../../src/core/domains/language/kernel/capability.js";
import { LanguageVersionDriftMonitor } from "../../../../../src/core/domains/maintenance/drift/language-version-drift-monitor.js";
import {
  formatIndexDriftReport,
  IndexDriftReporter,
} from "../../../../../src/core/domains/maintenance/drift/report.js";

/** The shared stamp every index carried before the chunk-owner rule landed. */
const STAMPED_BEFORE_CHUNK_OWNER = { chunking: 1, walker: 2, codegraphSchema: 1 };

describe("sharedVersions after the chunk-owner rule (bd tea-rags-mcp-9i2ow)", () => {
  const current = resolveLanguageCodeVersions(new LanguageFactory().capabilities(), () => undefined);

  it("an index stamped before it reports the shared codegraph schema and nothing else shared", () => {
    const drifts = LanguageVersionDriftMonitor.detectDrift(
      { [SHARED_LANGUAGE]: STAMPED_BEFORE_CHUNK_OWNER },
      new Map([[SHARED_LANGUAGE, current.get(SHARED_LANGUAGE)!]]),
      [],
    );

    expect(drifts).toEqual([
      { language: SHARED_LANGUAGE, axes: [{ axis: "codegraphSchema", indexed: 1, current: 2 }] },
    ]);
  });

  it("tells the operator to recompute codegraph for the whole collection", () => {
    const monitor = new LanguageVersionDriftMonitor(
      { get: () => ({ languageVersions: { [SHARED_LANGUAGE]: STAMPED_BEFORE_CHUNK_OWNER } }) },
      { load: () => ({ distributions: { language: {} } }) },
      new Map([[SHARED_LANGUAGE, current.get(SHARED_LANGUAGE)!]]),
    );

    const report = new IndexDriftReporter([monitor]).checkByCollectionName("code_abc123");
    const warning = report && formatIndexDriftReport(report);

    expect(warning).toContain("*.codegraphSchema: 1 → 2");
    expect(warning).toContain("Run: tea-rags index-codebase --force-enrichments codegraph");
    expect(warning).not.toContain("--languages");
    expect(warning).not.toContain("--force ");
  });
});
