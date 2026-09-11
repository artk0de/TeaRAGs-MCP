import { describe, expect, it } from "vitest";

import type { PayloadKeyOwner } from "../../../../../src/core/contracts/types/trajectory.js";
import {
  foldIndexDriftRemedies,
  renderIndexDriftRemedy,
  resolveSchemaDriftRemedy,
  type IndexDriftRemedy,
} from "../../../../../src/core/domains/maintenance/drift/remedy.js";
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

  it("escalates to the full reindex when no owners are supplied — nothing attributes the key", () => {
    const drift = { added: ["git.file.newSignal"], removed: [] };

    const warning = formatSchemaDriftWarning(drift);

    expect(warning).toContain("reindex");
    expect(warning).toContain("Run: tea-rags index-codebase --force");
  });
});

const recompute = (trajectories: string[], languages: string[] | null): IndexDriftRemedy => ({
  kind: "recompute",
  trajectories: new Set(trajectories),
  languages: languages === null ? null : new Set(languages),
});

describe("foldIndexDriftRemedies", () => {
  it("is none over an empty list", () => {
    expect(foldIndexDriftRemedies([])).toEqual({ kind: "none" });
  });

  it("keeps the language narrowing when every recompute names a language", () => {
    const folded = foldIndexDriftRemedies([recompute(["codegraph"], ["ruby"]), recompute(["codegraph"], ["python"])]);

    expect(folded).toEqual(recompute(["codegraph"], ["python", "ruby"]));
  });

  it("drops the narrowing when one recompute is collection-wide", () => {
    const folded = foldIndexDriftRemedies([recompute(["codegraph"], ["ruby"]), recompute(["git"], null)]);

    expect(folded).toEqual(recompute(["codegraph", "git"], null));
  });

  it("force subsumes every recompute", () => {
    expect(foldIndexDriftRemedies([recompute(["git"], null), { kind: "force" }])).toEqual({ kind: "force" });
  });

  it("incremental outranks none only", () => {
    expect(foldIndexDriftRemedies([{ kind: "none" }, { kind: "incremental" }])).toEqual({ kind: "incremental" });
    expect(foldIndexDriftRemedies([{ kind: "incremental" }, recompute(["git"], null)])).toEqual(
      recompute(["git"], null),
    );
  });

  it("renders one command", () => {
    expect(renderIndexDriftRemedy(recompute(["git", "codegraph"], ["ruby"]))).toBe(
      "Run: tea-rags index-codebase --force-enrichments codegraph,git --languages ruby",
    );
    expect(renderIndexDriftRemedy({ kind: "force" })).toBe("Run: tea-rags index-codebase --force");
    expect(renderIndexDriftRemedy({ kind: "incremental" })).toBe("Run: tea-rags index-codebase --project <alias>");
    expect(renderIndexDriftRemedy({ kind: "incremental" }, "taxdome")).toBe(
      "Run: tea-rags index-codebase --project taxdome",
    );
    expect(renderIndexDriftRemedy(recompute(["git"], null), "taxdome")).toBe(
      "Run: tea-rags index-codebase --project taxdome --force-enrichments git",
    );
    expect(renderIndexDriftRemedy({ kind: "none" })).toBe("No action required.");
  });
});

// Moved from language-version-drift-monitor.test.ts: the routed command is no
// longer the monitor's to render, but the doctrine it encodes is unchanged.
describe("the one command a language-version drift carries", () => {
  const edgesOnly = (language: string): IndexDriftRemedy => recompute(["codegraph"], [language]);
  const movesChunkSet: IndexDriftRemedy = { kind: "force" };

  it("routes an edges-only bump to the narrowed enrichment recompute", () => {
    expect(renderIndexDriftRemedy(foldIndexDriftRemedies([edgesOnly("typescript")]))).toBe(
      "Run: tea-rags index-codebase --force-enrichments codegraph --languages typescript",
    );
  });

  it("routes a codegraph-schema bump the same way", () => {
    expect(renderIndexDriftRemedy(foldIndexDriftRemedies([edgesOnly("ruby")]))).toBe(
      "Run: tea-rags index-codebase --force-enrichments codegraph --languages ruby",
    );
  });

  it("comma-separates the languages of one recompute rather than emitting two commands", () => {
    const command = renderIndexDriftRemedy(foldIndexDriftRemedies([edgesOnly("typescript"), edgesOnly("ruby")]));

    expect(command).toContain("--force-enrichments codegraph --languages ruby,typescript");
    expect(command.match(/Run: /g)).toHaveLength(1);
  });

  it("routes a grammar bump to a full reindex — the chunk set moves", () => {
    expect(renderIndexDriftRemedy(foldIndexDriftRemedies([movesChunkSet]))).toBe(
      "Run: tea-rags index-codebase --force",
    );
  });

  it("routes a chunking bump to a full reindex", () => {
    expect(renderIndexDriftRemedy(foldIndexDriftRemedies([movesChunkSet]))).toBe(
      "Run: tea-rags index-codebase --force",
    );
  });

  it("never narrows the full reindex by language — that would drop every other language from the index", () => {
    expect(renderIndexDriftRemedy(foldIndexDriftRemedies([movesChunkSet]))).not.toContain("--languages");
  });

  it("escalates a mixed drift to the single command that subsumes the other", () => {
    const command = renderIndexDriftRemedy(foldIndexDriftRemedies([movesChunkSet, edgesOnly("typescript")]));

    expect(command.match(/Run: /g)).toHaveLength(1);
    expect(command).toContain("Run: tea-rags index-codebase --force");
    expect(command).not.toContain("--force-enrichments");
  });
});

describe("resolveSchemaDriftRemedy", () => {
  const OWNERS: PayloadKeyOwner[] = [
    { key: "git.file.newSignal", trajectory: "git", recomputable: true },
    { key: "codegraph.file.newMetric", trajectory: "codegraph.symbols", recomputable: true },
    { key: "chunkSize", trajectory: "static", recomputable: false },
    { key: "navigation", recomputable: false },
  ];

  it("is none when the drift is removals only", () => {
    expect(resolveSchemaDriftRemedy({ added: [], removed: ["git.file.retiredSignal"] }, OWNERS)).toEqual({
      kind: "none",
    });
  });

  it("recomputes the owning trajectory of every added key", () => {
    expect(
      resolveSchemaDriftRemedy({ added: ["git.file.newSignal", "codegraph.file.newMetric"], removed: [] }, OWNERS),
    ).toEqual(recompute(["codegraph.symbols", "git"], null));
  });

  it("never narrows a payload-key recompute by language — the keys are language-agnostic", () => {
    const remedy = resolveSchemaDriftRemedy({ added: ["git.file.newSignal"], removed: [] }, OWNERS);

    expect(remedy).toEqual({ kind: "recompute", trajectories: new Set(["git"]), languages: null });
  });

  it("escalates to force when an added key is owned by a non-enriching trajectory", () => {
    expect(resolveSchemaDriftRemedy({ added: ["chunkSize"], removed: [] }, OWNERS)).toEqual({ kind: "force" });
  });

  it("escalates to force when an added key has no declared owner", () => {
    expect(resolveSchemaDriftRemedy({ added: ["mystery.field"], removed: [] }, OWNERS)).toEqual({ kind: "force" });
  });

  it("escalates to force when an owner declares no trajectory", () => {
    expect(resolveSchemaDriftRemedy({ added: ["navigation"], removed: [] }, OWNERS)).toEqual({ kind: "force" });
  });
});
