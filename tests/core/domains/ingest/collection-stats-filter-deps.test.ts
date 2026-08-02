import { describe, expect, it } from "vitest";

import type { FilterPresetDef } from "../../../../src/core/contracts/index.js";
import type { PayloadSignalDescriptor } from "../../../../src/core/contracts/types/trajectory.js";
import { validateSignalDependencies } from "../../../../src/core/domains/ingest/infra/collection-stats.js";

describe("validateSignalDependencies — filter percentiles", () => {
  const sig = (key: string, pcts: number[]): PayloadSignalDescriptor =>
    ({ key, type: "number", stats: { percentilesToCompute: pcts } }) as PayloadSignalDescriptor;
  const preset: FilterPresetDef = {
    name: "x",
    description: "",
    conditions: [{ signal: "git.file.commitCount", op: "gte", value: { percentile: "p75", fallback: 9 } }],
  };
  it("throws when p75 of the referenced signal is not declared", () => {
    expect(() => {
      validateSignalDependencies([sig("git.file.commitCount", [25])], [preset]);
    }).toThrow(/p75|commitCount/);
  });
  it("passes when p75 is declared in percentilesToCompute", () => {
    expect(() => {
      validateSignalDependencies([sig("git.file.commitCount", [75])], [preset]);
    }).not.toThrow();
  });
  it("passes when no filter presets are given (back-compat)", () => {
    expect(() => {
      validateSignalDependencies([sig("git.file.commitCount", [25])]);
    }).not.toThrow();
  });
});
