/**
 * `CodegraphRunState.hasRunGlobalEntries` (bd tea-rags-mcp-8zwl9) — the
 * constant-time replacement for `Object.keys(map).length > 0` on the six
 * run-global maps pass-2 chooses between.
 *
 * An index's whole cost is that it CAN disagree with the thing it describes, so
 * every case here checks the flag against the map it stands for rather than
 * against a remembered expectation. The reset seams matter most: they clear
 * OVERLAPPING BUT NOT IDENTICAL field sets, so a flag cleared in the wrong seam
 * sends pass-2 to the per-file fallback while the run-global map still holds
 * facts — a silently wrong edge, not a crash.
 */

import { describe, expect, it } from "vitest";

import type { FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import {
  CodegraphRunState,
  type RunGlobalMapName,
} from "../../../../../../src/core/domains/trajectory/codegraph/symbols/run-state.js";

const RUN_GLOBAL_MAPS: readonly RunGlobalMapName[] = [
  "ancestors",
  "prependedAncestors",
  "classExtends",
  "returnTypes",
  "ivarTypes",
  "structuredReturnTypes",
];

/**
 * The invariant, stated once: the flag says exactly what a key count would.
 * Asserted as an object so a failure names which map drifted.
 */
function expectFlagsMatchMaps(runState: CodegraphRunState): void {
  const fromFlag: Record<string, boolean> = {};
  const fromMap: Record<string, boolean> = {};
  for (const name of RUN_GLOBAL_MAPS) {
    fromFlag[name] = runState.hasRunGlobalEntries(name);
    fromMap[name] = Object.keys(runState[name]).length > 0;
  }
  expect(fromFlag).toEqual(fromMap);
}

/** One file's pass-1 contribution to all six run-global maps. */
function contributingExtraction(relPath: string): FileExtraction {
  return {
    relPath,
    language: "ruby",
    imports: [],
    fileScope: [],
    chunks: [],
    classAncestors: { Account: ["ApplicationRecord"] },
    classPrependedAncestors: { Account: ["Auditable"] },
    classExtends: { Account: "ApplicationRecord" },
    functionReturnTypes: { build_account: "Account" },
    ivarTypes: { Account: { "@firm": "Firm" } },
    structuredReturnTypes: { "Account#firm": { form: "instance", name: "Firm" } },
  } as unknown as FileExtraction;
}

describe("CodegraphRunState tracks which run-global maps a run contributed to (bd tea-rags-mcp-8zwl9)", () => {
  it("reports every map as unpopulated before any file is absorbed", () => {
    const runState = new CodegraphRunState();

    for (const name of RUN_GLOBAL_MAPS) expect(runState.hasRunGlobalEntries(name)).toBe(false);
    expectFlagsMatchMaps(runState);
  });

  it("flips each map's answer once a file actually contributes to it", () => {
    const runState = new CodegraphRunState();

    runState.absorb(contributingExtraction("app/models/account.rb"), []);

    for (const name of RUN_GLOBAL_MAPS) expect(runState.hasRunGlobalEntries(name)).toBe(true);
    expectFlagsMatchMaps(runState);
  });

  it("stays unpopulated for a field the extraction declared but left empty", () => {
    const runState = new CodegraphRunState();

    // Presence of the field is not a contribution — the loop writes nothing, so
    // the map is still empty and the answer must still be `false`. A flag set on
    // field presence instead of on a write would diverge exactly here.
    runState.absorb(
      {
        relPath: "app/models/empty.rb",
        language: "ruby",
        imports: [],
        fileScope: [],
        chunks: [],
        classAncestors: {},
        classExtends: {},
        ivarTypes: {},
      } as unknown as FileExtraction,
      [],
    );

    for (const name of RUN_GLOBAL_MAPS) expect(runState.hasRunGlobalEntries(name)).toBe(false);
    expectFlagsMatchMaps(runState);
  });

  it("forgets every contribution when clearForNextRun empties the maps", () => {
    const runState = new CodegraphRunState();
    runState.absorb(contributingExtraction("app/models/account.rb"), []);

    runState.clearForNextRun();

    for (const name of RUN_GLOBAL_MAPS) expect(runState.hasRunGlobalEntries(name)).toBe(false);
    expectFlagsMatchMaps(runState);
  });

  it("forgets every contribution when clearAll empties the maps on worker release", () => {
    const runState = new CodegraphRunState();
    runState.absorb(contributingExtraction("app/models/account.rb"), []);

    runState.clearAll();

    for (const name of RUN_GLOBAL_MAPS) expect(runState.hasRunGlobalEntries(name)).toBe(false);
    expectFlagsMatchMaps(runState);
  });

  it("forgets every contribution on the empty-run branch of drainMetrics", () => {
    const runState = new CodegraphRunState();
    runState.absorb(contributingExtraction("app/models/account.rb"), []);

    // No files extracted, no edges: the wide reset branch.
    expect(runState.drainMetrics()).toBeUndefined();

    for (const name of RUN_GLOBAL_MAPS) expect(runState.hasRunGlobalEntries(name)).toBe(false);
    expectFlagsMatchMaps(runState);
  });

  it("forgets only the ancestor maps on the real-run branch of drainMetrics", () => {
    const runState = new CodegraphRunState();
    runState.absorb(contributingExtraction("app/models/account.rb"), []);
    runState.stats.extractedFiles = 1;
    runState.stats.fileEdgeCount = 1;

    expect(runState.drainMetrics()).toBeDefined();

    // This seam clears the two ancestor maps and deliberately leaves the other
    // four standing — inherited from the pre-split provider. The flags must
    // follow the maps exactly, not the seam's name.
    expect(runState.hasRunGlobalEntries("ancestors")).toBe(false);
    expect(runState.hasRunGlobalEntries("prependedAncestors")).toBe(false);
    expect(runState.hasRunGlobalEntries("classExtends")).toBe(true);
    expect(runState.hasRunGlobalEntries("returnTypes")).toBe(true);
    expect(runState.hasRunGlobalEntries("ivarTypes")).toBe(true);
    expect(runState.hasRunGlobalEntries("structuredReturnTypes")).toBe(true);
    expectFlagsMatchMaps(runState);
  });

  it("keeps the invariant across a full run, reset, and second run on one instance", () => {
    const runState = new CodegraphRunState();

    runState.absorb(contributingExtraction("app/models/account.rb"), []);
    expectFlagsMatchMaps(runState);
    runState.clearForNextRun();
    expectFlagsMatchMaps(runState);
    runState.absorb(contributingExtraction("app/models/firm.rb"), []);

    // A cached provider on the daemon serves run after run; a flag that failed
    // to re-arm would make run 2 silently read per-file maps.
    for (const name of RUN_GLOBAL_MAPS) expect(runState.hasRunGlobalEntries(name)).toBe(true);
    expectFlagsMatchMaps(runState);
  });
});
