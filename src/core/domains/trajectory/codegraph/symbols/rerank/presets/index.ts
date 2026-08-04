import type { RerankPreset } from "../../../../../../contracts/types/reranker.js";
import { CriticalMethodPreset } from "./critical-method.js";
import { GodMethodPreset } from "./god-method.js";
import { HotMethodPreset } from "./hot-method.js";

/**
 * Codegraph trajectory presets — pure single-trajectory presets only.
 *
 * Everything here weights `codegraph.*` signals and nothing else, so the
 * trajectory's own registration is the gate: the class files load only when the
 * codegraph trajectory is wired, and no `requires` declaration is needed.
 *
 * A preset that reaches into another trajectory — `churn`, `bugFix`, any git
 * or static signal — is a COMPOSITE and belongs in
 * `domains/trajectory/composite/presets/` instead, where
 * `buildCompositePresets({ ... })` from `api/internal/composition.ts` gates it
 * on `requires` and `resolvePresets(registry, composite)` carries it to the
 * reranker. Slice 1 put `BlastRadiusPreset` here and had to move it out for
 * exactly that reason.
 *
 * The three method-centrality presets split one call graph into three
 * questions: `criticalMethod` (transitive weight — PageRank), `hotMethod`
 * (incoming calls — cost to touch), `godMethod` (outgoing calls — doing too
 * much). Each scores its own axis and carries the other two in the overlay.
 */
export const CODEGRAPH_SYMBOLS_PRESETS: RerankPreset[] = [
  new CriticalMethodPreset(),
  new HotMethodPreset(),
  new GodMethodPreset(),
];
