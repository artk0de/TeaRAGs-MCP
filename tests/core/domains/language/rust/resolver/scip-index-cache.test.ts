/**
 * The rust-analyzer SCIP index of the pass's project (bd s3i8m.6 R2b): bulk
 * admission over non-test files, the never-rejecting warm, one shared
 * acquisition per root, and the sync hand-off to the resolve environment.
 */
import { describe, expect, it } from "vitest";

import type { CallContext, SymbolResolutionPassPlan } from "../../../../../../src/core/contracts/types/codegraph.js";
import type {
  RustAnalyzerScipAcquisition,
  RustAnalyzerScipAdmission,
  RustAnalyzerScipIndex,
  RustAnalyzerScipSource,
} from "../../../../../../src/core/contracts/types/language.js";
import { RustResolveEnvironmentCache } from "../../../../../../src/core/domains/language/rust/resolver/resolve-environment-cache.js";
import {
  rustAnalyzerScipOf,
  withRustResolveEnvironment,
} from "../../../../../../src/core/domains/language/rust/resolver/resolve-environment.js";
import {
  rustAnalyzerScipAdmission,
  RustAnalyzerScipIndexCache,
} from "../../../../../../src/core/domains/language/rust/resolver/scip-index-cache.js";

const ROOT = "/repo";

function plan(expectedFileCount: number): SymbolResolutionPassPlan {
  return { expectedFileCount, projectRoot: ROOT };
}

function scipIndex(identity: string): RustAnalyzerScipIndex {
  return { identity, definitionAt: () => null };
}

function indexed(identity = "env:content"): RustAnalyzerScipAcquisition {
  return { kind: "indexed", index: scipIndex(identity), cacheHit: true, toolchainSkew: false };
}

/** A source that records each request and answers with `answer`. */
function recordingSource(answer: () => Promise<RustAnalyzerScipAcquisition>): {
  source: RustAnalyzerScipSource;
  requests: { projectRoot: string; admission: RustAnalyzerScipAdmission }[];
} {
  const requests: { projectRoot: string; admission: RustAnalyzerScipAdmission }[] = [];
  return {
    requests,
    source: {
      acquire: async (request) => {
        requests.push(request);
        return answer();
      },
    },
  };
}

const isTestPath = (relPath: string): boolean => relPath.startsWith("tests/") || relPath.endsWith("_test.rs");

describe("rustAnalyzerScipAdmission (bd s3i8m.6 R2b)", () => {
  const files = (count: number, prefix = "src/f"): string[] =>
    Array.from({ length: count }, (_, i) => `${prefix}${i}.rs`);

  it("spawns at half the project's non-test files and refuses one file below", () => {
    expect(rustAnalyzerScipAdmission(50, isTestPath)(files(100))).toBe("spawn");
    expect(rustAnalyzerScipAdmission(49, isTestPath)(files(100))).toBe("reuseOnly");
  });

  it("leaves test files out of the denominator, so a test-heavy crate's full run is still bulk", () => {
    const project = [...files(40), ...files(160, "tests/t")];
    // The run resolves all 40 non-test files; 40 of 200 would read as incremental.
    expect(rustAnalyzerScipAdmission(40, isTestPath)(project)).toBe("spawn");
    expect(rustAnalyzerScipAdmission(19, isTestPath)(project)).toBe("reuseOnly");
  });
});

describe("RustAnalyzerScipIndexCache (bd s3i8m.6 R2b)", () => {
  it("hands the acquired index to forRoot for its root only", async () => {
    const { source } = recordingSource(async () => indexed());
    const cache = new RustAnalyzerScipIndexCache(source, isTestPath);

    await cache.warm(plan(10));

    expect(cache.forRoot(ROOT)?.identity).toBe("env:content");
    expect(cache.forRoot("/other")).toBeUndefined();
    expect(cache.forRoot(undefined)).toBeUndefined();
    expect(cache.diagnostics()).toEqual({ outcome: "indexed", cacheHit: true, toolchainSkew: false });
  });

  it("passes the bulk admission for the plan's file count to the source", async () => {
    const { source, requests } = recordingSource(async () => indexed());
    const cache = new RustAnalyzerScipIndexCache(source, isTestPath);

    await cache.warm(plan(3));

    expect(requests.map((request) => request.projectRoot)).toEqual([ROOT]);
    expect(requests[0]?.admission(["src/a.rs", "src/b.rs", "src/c.rs", "src/d.rs", "src/e.rs", "src/f.rs"])).toBe(
      "spawn",
    );
    expect(
      requests[0]?.admission(["src/a.rs", "src/b.rs", "src/c.rs", "src/d.rs", "src/e.rs", "src/f.rs", "src/g.rs"]),
    ).toBe("reuseOnly");
  });

  it("records a rejected source as a latched exit and never rejects", async () => {
    const { source } = recordingSource(async () => Promise.reject(new Error("boom")));
    const cache = new RustAnalyzerScipIndexCache(source, isTestPath);

    await expect(cache.warm(plan(10))).resolves.toBeUndefined();

    expect(cache.forRoot(ROOT)).toBeUndefined();
    expect(cache.diagnostics()).toEqual({ outcome: "latched", reason: "exit" });
  });

  it("shares one acquisition between concurrent warms of a root", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { source, requests } = recordingSource(async () => {
      await gate;
      return indexed();
    });
    const cache = new RustAnalyzerScipIndexCache(source, isTestPath);

    const first = cache.warm(plan(10));
    const second = cache.warm(plan(10));
    release();
    await Promise.all([first, second]);

    expect(requests).toHaveLength(1);
    expect(cache.forRoot(ROOT)).toBeDefined();
  });

  it("acquires nothing without a source, a root, or files to resolve", async () => {
    const { source, requests } = recordingSource(async () => indexed());

    await new RustAnalyzerScipIndexCache(undefined, isTestPath).warm(plan(10));
    await new RustAnalyzerScipIndexCache(source, isTestPath).warm({ expectedFileCount: 10 });
    await new RustAnalyzerScipIndexCache(source, isTestPath).warm(plan(0));

    expect(requests).toEqual([]);
  });

  it("reports a skipped acquisition with its reason and serves no index", async () => {
    const { source } = recordingSource(async () => ({ kind: "skipped", reason: "noBinary" }));
    const cache = new RustAnalyzerScipIndexCache(source, isTestPath);

    await cache.warm(plan(10));

    expect(cache.forRoot(ROOT)).toBeUndefined();
    expect(cache.diagnostics()).toEqual({ outcome: "skipped", reason: "noBinary" });
  });
});

describe("RustResolveEnvironmentCache carries the SCIP index (bd s3i8m.6 R2b)", () => {
  const ctx = (projectRoot: string): CallContext => ({ projectRoot }) as unknown as CallContext;

  it("binds no environment while nothing was loaded or acquired", () => {
    expect(new RustResolveEnvironmentCache().forRoot(ROOT)).toBeUndefined();
  });

  it("rebinds when the acquired index changes, and rustAnalyzerScipOf reads it off the ctx", async () => {
    let identity = "first";
    const { source } = recordingSource(async () => indexed(identity));
    const environments = new RustResolveEnvironmentCache(undefined, undefined, source);

    await environments.warm(plan(10));
    const first = environments.forRoot(ROOT);
    expect(environments.forRoot(ROOT)).toBe(first);
    expect(rustAnalyzerScipOf(withRustResolveEnvironment(ctx(ROOT), first))?.identity).toBe("first");

    identity = "second";
    await environments.warm(plan(10));
    const second = environments.forRoot(ROOT);
    expect(second).not.toBe(first);
    expect(rustAnalyzerScipOf(withRustResolveEnvironment(ctx(ROOT), second))?.identity).toBe("second");
  });

  it("reads nothing off a ctx the Rust resolver did not enrich", () => {
    expect(rustAnalyzerScipOf(ctx(ROOT))).toBeUndefined();
  });
});
