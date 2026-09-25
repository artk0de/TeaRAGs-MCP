import { describe, expect, it } from "vitest";

import {
  describeUnenforcedHeapCeiling,
  HEAP_CEILING_ENFORCEMENT_TOLERANCE,
} from "../../../../../../../src/core/domains/ingest/pipeline/enrichment/infra/heap-ceiling-enforcement.js";

const MB = 1024 * 1024;

/**
 * bd tea-rags-mcp-6aytq — the enrichment worker's heap ceiling can be silently
 * inert, and the run that discovers it discovers it by swapping the host.
 *
 * `ENRICHMENT_WORKER_MEMORY_LIMIT_MB` is applied as
 * `resourceLimits.maxOldGenerationSizeMb`, which a process-wide
 * `NODE_OPTIONS=--max_old_space_size=...` overrides outright. Probed on the dev
 * machine: a thread declaring 128 MB reported `heap_size_limit` 8384 MB and
 * never raised `ERR_WORKER_OUT_OF_MEMORY`; with the env stripped, the same
 * declaration was enforced. Nothing anywhere said so — which is what this
 * comparison exists to say, once, at worker boot.
 */
describe("describeUnenforcedHeapCeiling", () => {
  it("stays silent when the thread declared no ceiling at all", () => {
    expect(describeUnenforcedHeapCeiling({ heapSizeLimitBytes: 8384 * MB })).toBeUndefined();
  });

  it("stays silent when the ceiling was explicitly disabled with 0", () => {
    expect(
      describeUnenforcedHeapCeiling({
        declaredMaxOldGenerationSizeMb: 0,
        heapSizeLimitBytes: 8384 * MB,
      }),
    ).toBeUndefined();
  });

  it("stays silent for V8's own headroom over an ENFORCED ceiling (measured 2048 declared -> 2240 actual)", () => {
    expect(
      describeUnenforcedHeapCeiling({
        declaredMaxOldGenerationSizeMb: 2048,
        heapSizeLimitBytes: 2240 * MB,
      }),
    ).toBeUndefined();
  });

  it("stays silent exactly at the tolerance, and speaks just above it", () => {
    const declaredMaxOldGenerationSizeMb = 2048;
    const atTolerance = declaredMaxOldGenerationSizeMb * HEAP_CEILING_ENFORCEMENT_TOLERANCE;
    expect(
      describeUnenforcedHeapCeiling({
        declaredMaxOldGenerationSizeMb,
        heapSizeLimitBytes: atTolerance * MB,
      }),
    ).toBeUndefined();
    expect(
      describeUnenforcedHeapCeiling({
        declaredMaxOldGenerationSizeMb,
        heapSizeLimitBytes: (atTolerance + 1) * MB,
      }),
    ).toBeDefined();
  });

  it("names both figures and the process-wide override when the ceiling is inert", () => {
    const warning = describeUnenforcedHeapCeiling({
      declaredMaxOldGenerationSizeMb: 6144,
      heapSizeLimitBytes: 8384 * MB,
    });
    expect(warning).toBeDefined();
    expect(warning).toContain("6144 MB");
    expect(warning).toContain("8384 MB");
    expect(warning).toContain("NODE_OPTIONS");
    expect(warning).toContain("--max_old_space_size");
    expect(warning).toContain("ENRICHMENT_WORKER_MEMORY_LIMIT_MB");
  });

  it("is ONE line — the boot path emits it verbatim behind a single prefix", () => {
    const warning = describeUnenforcedHeapCeiling({
      declaredMaxOldGenerationSizeMb: 2048,
      heapSizeLimitBytes: 8384 * MB,
    });
    expect(warning).not.toContain("\n");
  });

  /**
   * bd tea-rags-mcp-5nyzm — `heap_size_limit` is old generation PLUS young
   * generation. Measured on node 24.14.1 with NODE_OPTIONS unset: the thread's
   * own `resourceLimits.maxYoungGenerationSizeMb` reads 192 and every limit lands
   * at exactly declared + 192 (256->448, 352->544, 640->832, 4096->4288). A
   * ratio over the old generation alone flagged every enforced ceiling under
   * ~768 MB as inert.
   */
  describe("young-generation allowance (5nyzm)", () => {
    const YOUNG_MB = 192;
    const measuredEnforced: readonly (readonly [number, number])[] = [
      [256, 448],
      [352, 544],
      [640, 832],
      [4096, 4288],
    ];

    for (const [declaredMb, actualMb] of measuredEnforced) {
      it(`stays silent for an ENFORCED ${declaredMb} MB ceiling that V8 reports as ${actualMb} MB`, () => {
        expect(
          describeUnenforcedHeapCeiling({
            declaredMaxOldGenerationSizeMb: declaredMb,
            declaredMaxYoungGenerationSizeMb: YOUNG_MB,
            heapSizeLimitBytes: actualMb * MB,
          }),
        ).toBeUndefined();
      });

      it(`still speaks when NODE_OPTIONS --max_old_space_size=8192 overrides a declared ${declaredMb} MB ceiling`, () => {
        const warning = describeUnenforcedHeapCeiling({
          declaredMaxOldGenerationSizeMb: declaredMb,
          declaredMaxYoungGenerationSizeMb: YOUNG_MB,
          heapSizeLimitBytes: 8384 * MB,
        });
        expect(warning).toBeDefined();
        expect(warning).toContain(`${declaredMb} MB`);
        expect(warning).toContain("8384 MB");
      });
    }

    it("applies the tolerance to old + young, not to the old generation alone", () => {
      const expectedMb = 352 + YOUNG_MB;
      const atTolerance = expectedMb * HEAP_CEILING_ENFORCEMENT_TOLERANCE;
      const observe = (actualMb: number) =>
        describeUnenforcedHeapCeiling({
          declaredMaxOldGenerationSizeMb: 352,
          declaredMaxYoungGenerationSizeMb: YOUNG_MB,
          heapSizeLimitBytes: actualMb * MB,
        });
      expect(observe(atTolerance)).toBeUndefined();
      expect(observe(atTolerance + 1)).toBeDefined();
    });

    it("treats an unusable young-generation reading as no allowance", () => {
      for (const declaredMaxYoungGenerationSizeMb of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(
          describeUnenforcedHeapCeiling({
            declaredMaxOldGenerationSizeMb: 352,
            declaredMaxYoungGenerationSizeMb,
            heapSizeLimitBytes: 544 * MB,
          }),
        ).toBeDefined();
      }
    });
  });

  it("stays silent when V8 reports no usable heap limit", () => {
    for (const heapSizeLimitBytes of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        describeUnenforcedHeapCeiling({
          declaredMaxOldGenerationSizeMb: 2048,
          heapSizeLimitBytes,
        }),
      ).toBeUndefined();
    }
  });

  it("stays silent on a nonsensical declared ceiling rather than reporting one", () => {
    for (const declaredMaxOldGenerationSizeMb of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        describeUnenforcedHeapCeiling({
          declaredMaxOldGenerationSizeMb,
          heapSizeLimitBytes: 8384 * MB,
        }),
      ).toBeUndefined();
    }
  });
});
