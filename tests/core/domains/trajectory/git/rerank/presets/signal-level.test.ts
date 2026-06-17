import { describe, expect, it } from "vitest";

import type { RerankPreset } from "../../../../../../../src/core/contracts/types/reranker.js";
import { buildCompositePresets } from "../../../../../../../src/core/domains/trajectory/composite/presets/index.js";
import { CodeReviewPreset } from "../../../../../../../src/core/domains/trajectory/git/rerank/presets/code-review.js";
import { HotspotsPreset } from "../../../../../../../src/core/domains/trajectory/git/rerank/presets/hotspots.js";
import { GIT_PRESETS } from "../../../../../../../src/core/domains/trajectory/git/rerank/presets/index.js";
import { OnboardingPreset } from "../../../../../../../src/core/domains/trajectory/git/rerank/presets/onboarding.js";
import { OwnershipPreset } from "../../../../../../../src/core/domains/trajectory/git/rerank/presets/ownership.js";
import { ProvenPreset } from "../../../../../../../src/core/domains/trajectory/git/rerank/presets/proven.js";
import { RecentPreset } from "../../../../../../../src/core/domains/trajectory/git/rerank/presets/recent.js";
import { RefactoringPreset } from "../../../../../../../src/core/domains/trajectory/git/rerank/presets/refactoring.js";
import { SecurityAuditPreset } from "../../../../../../../src/core/domains/trajectory/git/rerank/presets/security-audit.js";
import { StablePreset } from "../../../../../../../src/core/domains/trajectory/git/rerank/presets/stable.js";
import { TechDebtPreset } from "../../../../../../../src/core/domains/trajectory/git/rerank/presets/tech-debt.js";

describe("preset signalLevel", () => {
  it.each([
    ["securityAudit", new SecurityAuditPreset()],
    ["ownership", new OwnershipPreset()],
    ["onboarding", new OnboardingPreset()],
    ["proven", new ProvenPreset()],
  ])("%s should have signalLevel file", (_name, preset) => {
    expect(preset.signalLevel).toBe("file");
  });

  it.each([
    ["hotspots", new HotspotsPreset()],
    ["codeReview", new CodeReviewPreset()],
    ["refactoring", new RefactoringPreset()],
    ["recent", new RecentPreset()],
    ["stable", new StablePreset()],
    ["techDebt", new TechDebtPreset()],
  ])("%s should not have signalLevel (defaults to chunk)", (_name, preset) => {
    expect(preset.signalLevel).toBeUndefined();
  });
});

// Chunk-scope derived signals whose extract() multiplies by payloadAlpha, which
// is 0 under signalLevel:"file". Weighting them in a file-level preset is dead
// weight: the signal always returns 0 yet its |weight| still inflates the
// score-normalization denominator, silently diluting every real signal.
// blockPenalty is NOT here — it returns full penalty (1.0) at alpha=0 by design.
const ALPHA_GATED_CHUNK_SIGNALS = ["chunkChurn", "chunkRelativeChurn"] as const;

const ALL_PRESETS: RerankPreset[] = [...GIT_PRESETS, ...buildCompositePresets(new Set(["codegraph.symbols", "git"]))];

describe("file-level presets must not weight alpha-gated chunk signals", () => {
  const fileLevelPresets = ALL_PRESETS.filter((p) => p.signalLevel === "file");

  it("covers both git and composite file-level presets", () => {
    // guard against an empty filter silently passing the assertion below
    expect(fileLevelPresets.length).toBeGreaterThanOrEqual(4);
  });

  it.each(ALPHA_GATED_CHUNK_SIGNALS)("no file-level preset weights %s", (signalKey) => {
    const offenders = fileLevelPresets.filter((p) => signalKey in p.weights).map((p) => p.name);
    expect(offenders).toEqual([]);
  });
});

describe("preset weight redistribution (chunkChurn removal)", () => {
  const sum = (w: Record<string, number>): number => Object.values(w).reduce((a, b) => a + Math.abs(b), 0);

  it.each([
    ["git securityAudit", new SecurityAuditPreset().weights, { bugFix: 0.15, volatility: 0.2 }],
    ["git ownership", new OwnershipPreset().weights, { ownership: 0.35, knowledgeSilo: 0.3 }],
  ])("%s drops chunkChurn, redistributes, keeps sum 1.0", (_name, weights, expected) => {
    expect("chunkChurn" in weights).toBe(false);
    expect(sum(weights)).toBeCloseTo(1.0, 6);
    for (const [k, v] of Object.entries(expected)) {
      expect(weights[k as keyof typeof weights]).toBeCloseTo(v, 6);
    }
  });
});
