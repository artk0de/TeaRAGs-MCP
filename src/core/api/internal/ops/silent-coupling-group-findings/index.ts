/**
 * Grouped silent-coupling finding barrel.
 *
 * A leaf component: `api/internal/ops/` has no facade, so its loose files belong
 * to the `api` component, while both surfaces that list silent coupling read
 * this shaping — the `ops/architecture-report/` detector family and the
 * `review_changes` diff detectors. Keeping it out of the loose ops files lets the
 * architecture-report child depend on a leaf instead of on `api`
 * (`tests/core/api/architecture-report-import-direction.test.ts` pins that).
 */

export {
  FIND_CO_CHANGED_LIMIT_MAX,
  SILENT_COUPLING_GROUP_EVIDENCE_PARTNERS,
  silentCouplingGroupDrillDown,
  silentCouplingGroupPartners,
} from "./silent-coupling-group-findings.js";
export type { SilentCouplingGroupedPair } from "./silent-coupling-group-findings.js";
