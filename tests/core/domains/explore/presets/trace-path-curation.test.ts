import { describe, expect, it } from "vitest";

import {
  getPresetNames,
  resolvePresets,
} from "../../../../../src/core/domains/explore/rerank/presets/index.js";
import { buildCompositePresets } from "../../../../../src/core/domains/trajectory/composite/presets/index.js";
import { GIT_PRESETS } from "../../../../../src/core/domains/trajectory/git/rerank/presets/index.js";
import { STATIC_PRESETS } from "../../../../../src/core/domains/trajectory/static/rerank/presets/index.js";

/**
 * Pins the curated `trace_path` rerank preset set (bead tea-rags-mcp-1314d).
 *
 * `trace_path` only runs when codegraph is enabled, so the resolved set must be
 * built with the codegraph trajectory registered — exactly the condition under
 * which the codegraph composite presets (which carry the `trace_path` tag for
 * the danger lenses) win the `(tool, name)` resolution over their git twins.
 *
 * The danger lenses (dangerous/hotspots/techDebt/codeReview/securityAudit/
 * ownership) are tagged for `trace_path` on their COMPOSITE form, not the git
 * form — so this guards that the composite override is what surfaces them. The
 * non-danger lenses (relevance/decomposition/refactoring/onboarding/
 * documentationRelevance) must NOT leak into a path-danger ranking.
 */
describe("trace_path curated preset set", () => {
  const CODEGRAPH_ON = new Set(["git", "static", "codegraph.symbols"]);
  const resolved = resolvePresets(
    [...GIT_PRESETS, ...STATIC_PRESETS],
    buildCompositePresets(CODEGRAPH_ON),
  );
  const tracePathPresets = getPresetNames(resolved, "trace_path").sort();

  const EXPECTED = [
    "architecturalHub",
    "blastRadius",
    "bugHunt",
    "codeReview",
    "dangerous",
    "entryPoint",
    "hotspots",
    "ownership",
    "proven",
    "recent",
    "securityAudit",
    "stable",
    "techDebt",
  ].sort();

  it("exposes exactly the 13 curated danger presets when codegraph is registered", () => {
    expect(tracePathPresets).toEqual(EXPECTED);
  });

  it.each(["relevance", "decomposition", "documentationRelevance", "refactoring", "onboarding"])(
    "excludes the non-danger preset %s from trace_path",
    (excluded) => {
      expect(tracePathPresets).not.toContain(excluded);
    },
  );
});
