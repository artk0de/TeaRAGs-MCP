import { describe, expect, it } from "vitest";

import { DEFAULT_AMBIGUOUS_RESOLVE_MODE } from "../../../../../src/core/contracts/types/codegraph.js";
import {
  CONE_MAX_DEFAULT,
  readResolverConfig,
} from "../../../../../src/core/domains/language/kernel/resolver-config.js";

describe("readResolverConfig", () => {
  it("defaults coneMax to 8 on an unset env", () => {
    expect(CONE_MAX_DEFAULT).toBe(8);
    expect(readResolverConfig({}, "CODEGRAPH_PY").coneMax).toBe(8);
    expect(readResolverConfig({}, "CODEGRAPH_RB").coneMax).toBe(8);
  });

  it("carries the given mode, defaulting to the ambiguous-resolve default", () => {
    expect(readResolverConfig({}, "CODEGRAPH_RB").mode).toBe(DEFAULT_AMBIGUOUS_RESOLVE_MODE);
  });

  it("reads <prefix>_CONE_MAX", () => {
    expect(readResolverConfig({ CODEGRAPH_PY_CONE_MAX: "3" }, "CODEGRAPH_PY").coneMax).toBe(3);
    expect(readResolverConfig({ CODEGRAPH_RB_CONE_MAX: "5" }, "CODEGRAPH_RB").coneMax).toBe(5);
  });

  it.each(["not-a-number", "0", "-2", "2.5", ""])("falls back to 8 on invalid CONE_MAX %j", (raw) => {
    expect(readResolverConfig({ CODEGRAPH_PY_CONE_MAX: raw }, "CODEGRAPH_PY").coneMax).toBe(8);
  });

  it("isolates Ruby from Python by prefix", () => {
    const env = { CODEGRAPH_PY_CONE_MAX: "3", CODEGRAPH_RB_DYNAMIC_CONFIDENCE: "0.25" };
    expect(readResolverConfig(env, "CODEGRAPH_RB").coneMax).toBe(8);
    expect(readResolverConfig(env, "CODEGRAPH_PY").dynamicReceiverConfidence).toBeUndefined();
  });

  it("reads <prefix>_DYNAMIC_CONFIDENCE as a float in (0,1]", () => {
    const read = (raw: string) => readResolverConfig({ CODEGRAPH_RB_DYNAMIC_CONFIDENCE: raw }, "CODEGRAPH_RB");
    expect(read("0.25").dynamicReceiverConfidence).toBe(0.25);
    expect(read("1").dynamicReceiverConfidence).toBe(1);
    for (const bad of ["0", "-0.5", "1.5", "abc", "NaN", "Infinity"]) {
      expect(read(bad).dynamicReceiverConfidence).toBeUndefined();
    }
  });

  it("leaves dynamicReceiverConfidence undefined when unset", () => {
    expect(readResolverConfig({}, "CODEGRAPH_RB").dynamicReceiverConfidence).toBeUndefined();
  });
});

describe("readResolverConfig — <prefix>_ASSIGNED_LOCAL_GATE (bd tea-rags-mcp-m99j1.1.59)", () => {
  const read = (raw: string) => readResolverConfig({ CODEGRAPH_RB_ASSIGNED_LOCAL_GATE: raw }, "CODEGRAPH_RB");

  it("reads 1/true as on and 0/false as off", () => {
    expect(read("1").assignedLocalGate).toBe(true);
    expect(read("true").assignedLocalGate).toBe(true);
    expect(read("0").assignedLocalGate).toBe(false);
    expect(read("false").assignedLocalGate).toBe(false);
  });

  it("leaves it undefined when unset or unparseable, so the consumer's default decides", () => {
    expect(readResolverConfig({}, "CODEGRAPH_RB").assignedLocalGate).toBeUndefined();
    expect(read("maybe").assignedLocalGate).toBeUndefined();
  });
});
