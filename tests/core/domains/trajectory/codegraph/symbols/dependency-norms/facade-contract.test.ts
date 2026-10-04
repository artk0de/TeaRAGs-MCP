/**
 * dependency-norms reaches the Otsu threshold primitive through the
 * foundation barrel (bd tea-rags-mcp-89k7k.24): the module imports
 * `../../../../../infra/graph/index.js`, where the primitive moved when the
 * temporal verdicts became a second-layer consumer — never a sibling
 * domain's barrel or the file behind it.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { resolveMajorityFlooredOtsuThreshold } from "../../../../../../../src/core/infra/graph/index.js";
import { resolveMajorityFlooredOtsuThreshold as deepResolve } from "../../../../../../../src/core/infra/graph/otsu-split.js";

const DEPENDENCY_NORMS_MODULE =
  "../../../../../../../src/core/domains/trajectory/codegraph/symbols/dependency-norms/dependency-norms.ts";

describe("dependency-norms foundation contract (bd tea-rags-mcp-89k7k.24)", () => {
  it("imports the otsu entry through the infra/graph foundation barrel, not a domain", () => {
    const source = readFileSync(new URL(DEPENDENCY_NORMS_MODULE, import.meta.url), "utf8");
    expect(source).not.toContain("boundary-diagnostics");
    expect(source).toContain('from "../../../../../infra/graph/index.js"');
  });

  it("exposes the otsu entry from the foundation barrel as the very function the module defines", () => {
    expect(typeof resolveMajorityFlooredOtsuThreshold).toBe("function");
    expect(resolveMajorityFlooredOtsuThreshold).toBe(deepResolve);
  });

  it("keeps the entry behaving through either path", () => {
    const viaBarrel = resolveMajorityFlooredOtsuThreshold([0.6, 0.7, 0.9, 0.95], {
      majority: 0.5,
      minPopulation: 4,
    });
    expect(viaBarrel.method).toBe("otsu");
    expect(viaBarrel.threshold).toBeGreaterThanOrEqual(0.7);
  });
});
