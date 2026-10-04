/**
 * dependency-norms reaches boundary-diagnostics through its facade (bd
 * tea-rags-mcp-0e4vf): the module imports `../boundary-diagnostics/index.js`,
 * never the `otsu-split.js` file behind it.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { resolveMajorityFlooredOtsuThreshold } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/boundary-diagnostics/index.js";
import { resolveMajorityFlooredOtsuThreshold as deepResolve } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/boundary-diagnostics/otsu-split.js";

const DEPENDENCY_NORMS_MODULE =
  "../../../../../../../src/core/domains/trajectory/codegraph/symbols/dependency-norms/dependency-norms.ts";

describe("dependency-norms facade contract (bd tea-rags-mcp-0e4vf)", () => {
  it("imports the otsu entry through the boundary-diagnostics facade, not the file", () => {
    const source = readFileSync(new URL(DEPENDENCY_NORMS_MODULE, import.meta.url), "utf8");
    expect(source).not.toContain('from "../boundary-diagnostics/otsu-split.js"');
    expect(source).toContain('from "../boundary-diagnostics/index.js"');
  });

  it("exposes the otsu entry from the facade as the very function the module defines", () => {
    expect(typeof resolveMajorityFlooredOtsuThreshold).toBe("function");
    expect(resolveMajorityFlooredOtsuThreshold).toBe(deepResolve);
  });

  it("keeps the entry behaving through either path", () => {
    const viaFacade = resolveMajorityFlooredOtsuThreshold([0.6, 0.7, 0.9, 0.95], {
      majority: 0.5,
      minPopulation: 4,
    });
    expect(viaFacade.method).toBe("otsu");
    expect(viaFacade.threshold).toBeGreaterThanOrEqual(0.7);
  });
});
