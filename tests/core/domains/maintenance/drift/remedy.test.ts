import { describe, expect, it } from "vitest";

import type { PayloadKeyOwner } from "../../../../../src/core/contracts/types/trajectory.js";
import {
  foldIndexDriftRemedies,
  renderIndexDriftRemedy,
  resolvePayloadKeyRemedy,
  type IndexDriftRemedy,
} from "../../../../../src/core/domains/maintenance/drift/remedy.js";

/**
 * What a whole payload-key drift costs: the per-key remedies, folded. This is
 * the composition `SchemaDriftMonitor` performs — it emits one finding per key
 * and the reporter folds them — expressed here so the attribution cases below
 * assert against the production path rather than a helper only tests call.
 */
const payloadDriftRemedy = (added: readonly string[], owners: readonly PayloadKeyOwner[]): IndexDriftRemedy => {
  const ownerByKey = new Map(owners.map((o) => [o.key, o]));
  return foldIndexDriftRemedies(added.map((key) => resolvePayloadKeyRemedy(key, ownerByKey)));
};

describe("Schema drift hint — trajectory attribution", () => {
  const OWNERS: PayloadKeyOwner[] = [
    { key: "git.file.commitCount", trajectory: "git", recomputable: true },
    { key: "git.file.newSignal", trajectory: "git", recomputable: true },
    { key: "codegraph.file.fanIn", trajectory: "codegraph.symbols", recomputable: true },
    { key: "codegraph.file.newMetric", trajectory: "codegraph.symbols", recomputable: true },
    { key: "chunkSize", trajectory: "static", recomputable: false },
    { key: "navigation", recomputable: false },
  ];

  const commandFor = (drift: { added: string[]; removed: string[] }, owners: PayloadKeyOwner[] = OWNERS): string =>
    renderIndexDriftRemedy(payloadDriftRemedy(drift.added, owners));

  it("names the owning trajectory for a single enrichment-owned key", () => {
    const command = commandFor({ added: ["git.file.newSignal"], removed: [] });

    expect(command).toContain("--force-enrichments git");
    expect(command).not.toContain("--force ");
  });

  it("lists every affected trajectory when several enrichment providers drift", () => {
    const command = commandFor({ added: ["git.file.newSignal", "codegraph.file.newMetric"], removed: [] });

    expect(command).toContain("--force-enrichments");
    expect(command).toContain("git");
    expect(command).toContain("codegraph.symbols");
  });

  it("escalates to a full reindex when any drifted key is not enrichment-owned", () => {
    const command = commandFor({ added: ["git.file.newSignal", "navigation"], removed: [] });

    // A full reindex repopulates the enrichment layer too, so the hint must
    // carry ONE command — never two competing ones.
    expect(command).toContain("--force");
    expect(command).not.toContain("--force-enrichments");
  });

  it("escalates for a chunker-written key that belongs to a non-enriching trajectory", () => {
    const command = commandFor({ added: ["chunkSize"], removed: [] });

    expect(command).toContain("--force");
    expect(command).not.toContain("--force-enrichments");
  });

  it("escalates for an unknown key with no declared owner", () => {
    const command = commandFor({ added: ["mystery.field"], removed: [] });

    expect(command).toContain("--force");
    expect(command).not.toContain("--force-enrichments");
  });

  it("asks for no action when the drift is removals only", () => {
    // Removed keys have no descriptor, so nothing reads them any more.
    // Demanding a full reindex here costs hours and repopulates nothing.
    const command = commandFor({ added: [], removed: ["git.file.retiredSignal"] });

    expect(command).not.toContain("--force");
    expect(command).toMatch(/no action|no reindex/i);
  });

  it("escalates to the full reindex when no owners are supplied — nothing attributes the key", () => {
    const command = commandFor({ added: ["git.file.newSignal"], removed: [] }, []);

    expect(command).toContain("Run: tea-rags index-codebase --force");
    expect(command).not.toContain("--force-enrichments");
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

  it("does not depend on the order the findings arrive in", () => {
    // Monitors run in registration order and each contributes its own remedy,
    // so the fold must be commutative or the command would depend on wiring.
    const remedies: IndexDriftRemedy[] = [
      { kind: "incremental" },
      recompute(["git"], ["ruby"]),
      recompute(["codegraph"], ["python"]),
    ];

    const folded = foldIndexDriftRemedies(remedies);

    expect(folded).toEqual(foldIndexDriftRemedies([...remedies].reverse()));
    expect(folded).toEqual(recompute(["codegraph", "git"], ["python", "ruby"]));
  });

  // Moved from the `resolveSchemaDriftRemedy` describe when that function was
  // deleted: it had no production caller, and the fold of per-key remedies IS
  // what `SchemaDriftMonitor` + `IndexDriftReporter` perform. Same inputs, same
  // expectations — only the entry point moved.
  const PAYLOAD_KEY_OWNERS: PayloadKeyOwner[] = [
    { key: "git.file.newSignal", trajectory: "git", recomputable: true },
    { key: "codegraph.file.newMetric", trajectory: "codegraph.symbols", recomputable: true },
  ];

  it("unions the owning trajectory of every added key", () => {
    expect(payloadDriftRemedy(["git.file.newSignal", "codegraph.file.newMetric"], PAYLOAD_KEY_OWNERS)).toEqual(
      recompute(["codegraph.symbols", "git"], null),
    );
  });

  it("never narrows a payload-key recompute by language — the keys are language-agnostic", () => {
    const remedy = payloadDriftRemedy(["git.file.newSignal"], PAYLOAD_KEY_OWNERS);

    expect(remedy).toEqual({ kind: "recompute", trajectories: new Set(["git"]), languages: null });
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

  // Which AXIS produces `movesChunkSet` is pinned at the monitor, in
  // language-version-drift-monitor.test.ts — a remedy literal here cannot see
  // CHUNK_SET_AXES, so the three per-axis cases that used to live here would
  // have stayed green with the routing deleted.
  it("escalates a mixed drift to the single command that subsumes the other", () => {
    const command = renderIndexDriftRemedy(foldIndexDriftRemedies([movesChunkSet, edgesOnly("typescript")]));

    expect(command.match(/Run: /g)).toHaveLength(1);
    expect(command).toContain("Run: tea-rags index-codebase --force");
    expect(command).not.toContain("--force-enrichments");
  });
});
