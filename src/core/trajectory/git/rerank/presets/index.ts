/**
 * Git trajectory preset classes — barrel export.
 *
 * Each preset is a class implementing RerankPreset with overlay mask.
 */

import type { RerankPreset } from "../../../../contracts/types/reranker.js";
import { CodeReviewPreset } from "./code-review.js";
import { HotspotsPreset } from "./hotspots.js";
import { OnboardingPreset } from "./onboarding.js";
import { OwnershipPreset } from "./ownership.js";
import { RecentPreset } from "./recent.js";
import { RefactoringPreset } from "./refactoring.js";
import { SecurityAuditPreset } from "./security-audit.js";
import { StablePreset } from "./stable.js";
import { TechDebtPreset } from "./tech-debt.js";

export { CodeReviewPreset } from "./code-review.js";
export { HotspotsPreset } from "./hotspots.js";
export { OnboardingPreset } from "./onboarding.js";
export { OwnershipPreset } from "./ownership.js";
export { RecentPreset } from "./recent.js";
export { RefactoringPreset } from "./refactoring.js";
export { SecurityAuditPreset } from "./security-audit.js";
export { StablePreset } from "./stable.js";
export { TechDebtPreset } from "./tech-debt.js";

export const GIT_PRESETS: RerankPreset[] = [
  new TechDebtPreset(),
  new HotspotsPreset(),
  new CodeReviewPreset(),
  new OnboardingPreset(),
  new SecurityAuditPreset(),
  new RefactoringPreset(),
  new OwnershipPreset(),
  new RecentPreset(),
  new StablePreset(),
];
