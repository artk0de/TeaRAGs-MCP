/**
 * Import-direction pin over the temporal verdicts (bd tea-rags-mcp-89k7k.24).
 *
 * The measurement substrate must not depend on the detector barrel:
 * `symbols/boundary-diagnostics` reads the temporal co-change graph (the
 * legal direction), so the inverse edge — a temporal verdict importing from
 * the detector domain — dies. Mechanism mirrors
 * `tests/core/api/public/sdp-type-import-direction.test.ts`: source scan over
 * real files, no module loading.
 *
 * The pin was proven FAILING against the pre-move source: split-merge.ts
 * imported `resolveMajorityFlooredOtsuThreshold` from the detector barrel.
 * The design call (orchestrator, 2026-10-04) moved the primitive to the
 * foundation — `core/infra/graph/otsu-split.ts`, the Tarjan/PageRank home —
 * and split-merge now imports it from there; this pin holds the direction
 * from here on.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const SPLIT_MERGE = "../../../../../../../src/core/domains/trajectory/codegraph/temporal/verdicts/split-merge.ts";

describe("temporal verdicts import direction (bd tea-rags-mcp-89k7k.24)", () => {
  it("split-merge imports no module under symbols/boundary-diagnostics", () => {
    const source = readFileSync(new URL(SPLIT_MERGE, import.meta.url), "utf8");
    expect(source).not.toMatch(/from\s+"[^"]*symbols\/boundary-diagnostics\//);
  });
});
