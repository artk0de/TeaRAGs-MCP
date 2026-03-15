import { describe, expect, it } from "vitest";

import { CodeReviewPreset } from "../../../../../../../src/core/domains/trajectory/git/rerank/presets/code-review.js";
import { HotspotsPreset } from "../../../../../../../src/core/domains/trajectory/git/rerank/presets/hotspots.js";
import { OnboardingPreset } from "../../../../../../../src/core/domains/trajectory/git/rerank/presets/onboarding.js";
import { OwnershipPreset } from "../../../../../../../src/core/domains/trajectory/git/rerank/presets/ownership.js";
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
