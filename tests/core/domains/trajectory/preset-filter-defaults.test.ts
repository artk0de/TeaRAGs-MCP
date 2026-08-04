import { describe, expect, it } from "vitest";

import type { RerankPreset } from "../../../../src/core/contracts/types/reranker.js";
import {
  ArchitecturalHubPreset,
  BlastRadiusPreset,
  BugHuntCompositePreset,
  CodeReviewCompositePreset,
  CriticalPathPreset,
  DangerousCompositePreset,
  EntryPointPreset,
  HotspotsCompositePreset,
  OwnershipCompositePreset,
  SecurityAuditCompositePreset,
  TechDebtCompositePreset,
} from "../../../../src/core/domains/trajectory/composite/presets/index.js";
import { GIT_PRESETS } from "../../../../src/core/domains/trajectory/git/rerank/presets/index.js";
import { STATIC_PRESETS } from "../../../../src/core/domains/trajectory/static/rerank/presets/index.js";

const COMPOSITE_PRESETS: RerankPreset[] = [
  new HotspotsCompositePreset(),
  new TechDebtCompositePreset(),
  new DangerousCompositePreset(),
  new OwnershipCompositePreset(),
  new SecurityAuditCompositePreset(),
  new CodeReviewCompositePreset(),
  new BlastRadiusPreset(),
  new ArchitecturalHubPreset(),
  new EntryPointPreset(),
  new CriticalPathPreset(),
  new BugHuntCompositePreset(),
];

const ALL_PRESETS: RerankPreset[] = [...GIT_PRESETS, ...STATIC_PRESETS, ...COMPOSITE_PRESETS];

/** Find a preset by name in a given list. */
function findIn(list: RerankPreset[], name: string): RerankPreset | undefined {
  return list.find((p) => p.name === name);
}

/** Names defined in BOTH git and composite — assert default on both. */
const DUAL_DEFINED = ["hotspots", "techDebt", "dangerous", "ownership", "securityAudit", "bugHunt"];

describe("rerank preset hygiene defaults", () => {
  it.each([
    ["proven", "production"],
    ["ownership", "production"],
    ["bugHunt", "production"],
    ["techDebt", "production"],
    ["hotspots", "production"],
    ["dangerous", "production"],
    ["securityAudit", "production"],
    ["blastRadius", "production"],
    ["architecturalHub", "production"],
    ["entryPoint", "production"],
    ["criticalPath", "production"],
    ["decomposition", "coreLogic"],
    ["refactoring", "coreLogic"],
  ])("%s defaults to {presets:%s}", (name, preset) => {
    // For dual-defined names, assert SOME assembled preset carries it; the
    // per-list assertions below pin down both git and composite explicitly.
    const found = findIn(ALL_PRESETS, name);
    expect(found?.filter).toEqual({ presets: preset });
  });

  it.each(["relevance", "documentationRelevance", "onboarding", "codeReview", "recent", "stable"])(
    "%s has no default filter",
    (name) => {
      // codeReview is dual-defined; both must remain undefined (asserted below too).
      const found = findIn(ALL_PRESETS, name);
      expect(found?.filter).toBeUndefined();
    },
  );

  it.each(DUAL_DEFINED)("dual-defined %s carries {presets:production} on BOTH git and composite", (name) => {
    expect(findIn(GIT_PRESETS, name)?.filter).toEqual({ presets: "production" });
    expect(findIn(COMPOSITE_PRESETS, name)?.filter).toEqual({ presets: "production" });
  });

  it("dual-defined codeReview has undefined filter on BOTH git and composite", () => {
    expect(findIn(GIT_PRESETS, "codeReview")?.filter).toBeUndefined();
    expect(findIn(COMPOSITE_PRESETS, "codeReview")?.filter).toBeUndefined();
  });
});
