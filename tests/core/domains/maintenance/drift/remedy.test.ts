import { describe, expect, it } from "vitest";

import type { PayloadKeyOwner } from "../../../../../src/core/contracts/types/trajectory.js";
import { formatSchemaDriftWarning } from "../../../../../src/core/domains/maintenance/drift/schema-drift.js";

describe("Schema drift hint — trajectory attribution", () => {
  const OWNERS: PayloadKeyOwner[] = [
    { key: "git.file.commitCount", trajectory: "git", recomputable: true },
    { key: "git.file.newSignal", trajectory: "git", recomputable: true },
    { key: "codegraph.file.fanIn", trajectory: "codegraph.symbols", recomputable: true },
    { key: "codegraph.file.newMetric", trajectory: "codegraph.symbols", recomputable: true },
    { key: "chunkSize", trajectory: "static", recomputable: false },
    { key: "navigation", recomputable: false },
  ];

  it("names the owning trajectory for a single enrichment-owned key", () => {
    const drift = { added: ["git.file.newSignal"], removed: [] };

    const warning = formatSchemaDriftWarning(drift, OWNERS);

    expect(warning).toContain("--force-enrichments git");
    expect(warning).not.toContain("--force ");
  });

  it("lists every affected trajectory when several enrichment providers drift", () => {
    const drift = { added: ["git.file.newSignal", "codegraph.file.newMetric"], removed: [] };

    const warning = formatSchemaDriftWarning(drift, OWNERS);

    expect(warning).toContain("--force-enrichments");
    expect(warning).toContain("git");
    expect(warning).toContain("codegraph.symbols");
  });

  it("escalates to a full reindex when any drifted key is not enrichment-owned", () => {
    const drift = { added: ["git.file.newSignal", "navigation"], removed: [] };

    const warning = formatSchemaDriftWarning(drift, OWNERS);

    // A full reindex repopulates the enrichment layer too, so the hint must
    // carry ONE command — never two competing ones.
    expect(warning).toContain("--force");
    expect(warning).not.toContain("--force-enrichments");
  });

  it("escalates for a chunker-written key that belongs to a non-enriching trajectory", () => {
    const drift = { added: ["chunkSize"], removed: [] };

    const warning = formatSchemaDriftWarning(drift, OWNERS);

    expect(warning).toContain("--force");
    expect(warning).not.toContain("--force-enrichments");
  });

  it("escalates for an unknown key with no declared owner", () => {
    const drift = { added: ["mystery.field"], removed: [] };

    const warning = formatSchemaDriftWarning(drift, OWNERS);

    expect(warning).toContain("--force");
    expect(warning).not.toContain("--force-enrichments");
  });

  it("asks for no action when the drift is removals only", () => {
    // Removed keys have no descriptor, so nothing reads them any more.
    // Demanding a full reindex here costs hours and repopulates nothing.
    const drift = { added: [], removed: ["git.file.retiredSignal"] };

    const warning = formatSchemaDriftWarning(drift, OWNERS);

    expect(warning).toContain("git.file.retiredSignal");
    expect(warning).not.toContain("--force");
    expect(warning).toMatch(/no action|no reindex/i);
  });

  it("keeps the legacy full-reindex hint when no owners are supplied", () => {
    const drift = { added: ["git.file.newSignal"], removed: [] };

    const warning = formatSchemaDriftWarning(drift);

    expect(warning).toContain("reindex");
  });
});
