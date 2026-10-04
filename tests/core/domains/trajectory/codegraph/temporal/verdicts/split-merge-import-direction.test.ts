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
 * SKIPPED, not green: the one live offender is a RUNTIME import —
 * `split-merge.ts` calls `resolveMajorityFlooredOtsuThreshold`, which is
 * defined in the detector domain
 * (`symbols/boundary-diagnostics/otsu-split.ts`). Removing the edge therefore
 * needs the primitive's ownership decided first (move `otsu-split.ts` to a
 * neutral home vs. a temporal-owned contract) — the orchestrator's design
 * call, out of scope for the bead's facade half. Flip this to a live `it`
 * once that lands; until then the assertion would sit permanently red.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const SPLIT_MERGE = "../../../../../../src/core/domains/trajectory/codegraph/temporal/verdicts/split-merge.ts";

describe("temporal verdicts import direction (bd tea-rags-mcp-89k7k.24)", () => {
  it.skip("split-merge imports no module under symbols/boundary-diagnostics", () => {
    const source = readFileSync(new URL(SPLIT_MERGE, import.meta.url), "utf8");
    expect(source).not.toMatch(/from\s+"[^"]*symbols\/boundary-diagnostics\//);
  });
});
