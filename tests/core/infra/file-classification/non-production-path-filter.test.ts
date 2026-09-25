/**
 * Non-production path classification (bd tea-rags-mcp-r8hme.9): development
 * tooling that lives beside the product — scripts, spikes, benchmarks,
 * examples, fixtures — is source code, stays indexed and searchable, and is not
 * part of the architecture a boundary diagnostic judges.
 */
import { describe, expect, it } from "vitest";

import { buildNonProductionPathFilter } from "../../../../src/core/infra/file-classification/index.js";

describe("buildNonProductionPathFilter", () => {
  const filter = buildNonProductionPathFilter();

  it.each([
    "scripts/stable-dependencies-report.ts",
    "scripts/spikes/pass1-fanout-profile.ts",
    "app/javascript/scripts/vitestRetryPass/retry.ts",
    "script/rails_runner.rb",
    "packages/core/spikes/probe.py",
    "benchmarks/indexing.ts",
    "bench/walk.rs",
    "examples/basic/main.go",
    "src/core/__fixtures__/graph.ts",
    "lib/fixtures/sample.rb",
  ])("classifies %s as non-production", (relPath) => {
    expect(filter.ignores(relPath)).toBe(true);
  });

  it.each([
    "src/core/domains/ingest/pipeline/enrichment/executor/worker-pool.ts",
    "src/mcp/tools/codegraph.ts",
    "src/cli/index.ts",
    "bin/tea-rags.ts",
    "lib/tasks/billing.rake",
    "app/models/scriptable.rb",
    "src/transcripts/reader.ts",
  ])("keeps %s in production", (relPath) => {
    expect(filter.ignores(relPath)).toBe(false);
  });
});
