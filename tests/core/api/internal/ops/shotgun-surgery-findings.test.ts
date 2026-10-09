/**
 * bd tea-rags-mcp-dm61n — the shotgun-surgery run hands the co-change build's
 * per-file line counts to the detector beside the bundles they describe.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  runShotgunSurgery,
  summariseShotgunSurgery,
} from "../../../../../src/core/api/internal/ops/shotgun-surgery-findings.js";
import type { TemporalCochangeGraph } from "../../../../../src/core/contracts/types/codegraph.js";
import type { ComponentGraph } from "../../../../../src/core/domains/trajectory/codegraph/symbols/index.js";
import type {
  detectShotgunSurgery,
  ShotgunSurgeryInput,
} from "../../../../../src/core/domains/trajectory/codegraph/temporal/index.js";

const detectorInputs: ShotgunSurgeryInput[] = [];

vi.mock("../../../../../src/core/domains/trajectory/codegraph/temporal/index.js", async (importOriginal) => {
  const actual = await importOriginal<{ detectShotgunSurgery: typeof detectShotgunSurgery }>();
  return {
    ...actual,
    detectShotgunSurgery: (input: ShotgunSurgeryInput) => {
      detectorInputs.push(input);
      return actual.detectShotgunSurgery(input);
    },
  };
});

const META = {
  head: "abc123",
  fingerprint: "fp",
  builtAt: 1_700_000_000,
  windowSince: 1_690_000_000,
  commitCount: 2,
  bundleCount: 2,
  admittedBundleCount: 2,
  maxFilesPerBundle: 10,
  minSupport: 2,
  maxPartnersPerFile: 20,
  admittedBurstCount: 2,
  burstWindowMinutes: 30,
  burstWindowMethod: "estimated" as const,
};

const COMPONENTS = {
  componentOf: new Map([
    ["a.ts", "A"],
    ["b.ts", "B"],
  ]),
  dependencies: [],
} as unknown as ComponentGraph;

describe("runShotgunSurgery — per-file line counts reach the detector (bd tea-rags-mcp-dm61n)", () => {
  beforeEach(() => {
    detectorInputs.length = 0;
  });

  it("passes the build's bundle file line counts through unchanged", () => {
    const bundleFileLines = new Map([[0, new Map([["a.ts", { added: 3, deleted: 1 }]])]]);
    const cochange: TemporalCochangeGraph = {
      meta: META,
      edges: [],
      bundles: new Map([[0, ["a.ts", "b.ts"]]]),
      bundleFileLines,
    };

    runShotgunSurgery(cochange, COMPONENTS, undefined);

    expect(detectorInputs).toHaveLength(1);
    expect(detectorInputs[0].bundleFileLines).toBe(bundleFileLines);
  });

  it("omits the field when the build recorded no line counts", () => {
    const cochange: TemporalCochangeGraph = { meta: META, edges: [], bundles: new Map([[0, ["a.ts", "b.ts"]]]) };

    runShotgunSurgery(cochange, COMPONENTS, undefined);

    expect(detectorInputs[0]).not.toHaveProperty("bundleFileLines");
  });
});

describe("summariseShotgunSurgery — mechanical and echo counts (bd tea-rags-mcp-dm61n)", () => {
  it("reports the four stage counts when line counts were recorded", () => {
    const bundleFileLines = new Map([[0, new Map([["a.ts", { added: 3, deleted: 1 }]])]]);
    const summary = summariseShotgunSurgery(
      runShotgunSurgery(
        { meta: META, edges: [], bundles: new Map([[0, ["a.ts", "b.ts"]]]), bundleFileLines },
        COMPONENTS,
        undefined,
      ),
    );

    expect(summary).toMatchObject({
      mechanicalTestedCount: 0,
      mechanicalCommitCount: 0,
      echoCandidatePairCount: 0,
      echoPairCount: 0,
    });
  });

  it("leaves them absent, never zero, when the build predates line counts", () => {
    const summary = summariseShotgunSurgery(
      runShotgunSurgery({ meta: META, edges: [], bundles: new Map([[0, ["a.ts", "b.ts"]]]) }, COMPONENTS, undefined),
    );

    expect(summary).not.toHaveProperty("mechanicalTestedCount");
    expect(summary).not.toHaveProperty("mechanicalCommitCount");
    expect(summary).not.toHaveProperty("echoCandidatePairCount");
    expect(summary).not.toHaveProperty("echoPairCount");
  });
});
