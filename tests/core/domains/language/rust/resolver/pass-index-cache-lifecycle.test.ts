import { describe, expect, it, vi } from "vitest";

import type { SymbolResolutionPassPlan } from "../../../../../../src/core/contracts/types/codegraph.js";
import {
  rustPassIndexAdmission,
  RustPassIndexCache,
  type RustPassIndexAcquisition,
} from "../../../../../../src/core/domains/language/rust/resolver/pass-index-cache.js";

type Acquisition = RustPassIndexAcquisition<string>;

const latched = (detail: string): Acquisition => ({ kind: "latched", reason: "threw", detail });

function plan(overrides: Partial<SymbolResolutionPassPlan>): SymbolResolutionPassPlan {
  return { projectRoot: "/repo", expectedFileCount: 10, ...overrides };
}

describe("rustPassIndexAdmission", () => {
  it("spawns for a bulk run and only reuses an existing index for a small incremental one, counting non-test files only", () => {
    const isTest = (relPath: string): boolean => relPath.startsWith("tests/");
    const files = ["src/a.rs", "src/b.rs", "tests/c.rs", "tests/d.rs", "tests/e.rs"];
    // Non-test files: 2. Bulk share is half of them: 1 expected file is enough to spawn.
    expect(rustPassIndexAdmission(2, isTest)(files)).toBe("spawn");
    expect(rustPassIndexAdmission(1, isTest)(files)).toBe("spawn");
    expect(rustPassIndexAdmission(1, isTest)(["a.rs", "b.rs", "c.rs", "d.rs"])).toBe("reuseOnly");
  });
});

describe("RustPassIndexCache", () => {
  it("acquires once per root, shares an in-flight acquisition, and exposes the index only for that root", async () => {
    let release: (value: Acquisition) => void = () => undefined;
    const acquire = vi.fn(
      async () =>
        new Promise<Acquisition>((resolve) => {
          release = resolve;
        }),
    );
    const cache = new RustPassIndexCache<string, Acquisition>(acquire, latched);

    expect(cache.lastAcquisition()).toBeUndefined();
    expect(cache.forRoot("/repo")).toBeUndefined();

    const first = cache.warm(plan({}));
    const second = cache.warm(plan({}));
    release({ kind: "indexed", index: "the-index" });
    await Promise.all([first, second]);

    expect(acquire).toHaveBeenCalledTimes(1);
    expect(cache.forRoot("/repo")).toBe("the-index");
    expect(cache.forRoot("/other")).toBeUndefined();
    expect(cache.forRoot(undefined)).toBeUndefined();
    expect(cache.lastAcquisition()).toEqual({ kind: "indexed", index: "the-index" });
  });

  it("hands the admission built from the plan's file count to the port", async () => {
    const acquire = vi.fn(
      async ({ admission }: { admission: (paths: readonly string[]) => string }): Promise<Acquisition> => {
        expect(admission(["a.rs", "b.rs"])).toBe("spawn");
        return { kind: "skipped", reason: "no-driver" };
      },
    );
    const cache = new RustPassIndexCache<string, Acquisition>(acquire, latched, () => false);
    await cache.warm(plan({ expectedFileCount: 2 }));
    expect(cache.lastAcquisition()).toEqual({ kind: "skipped", reason: "no-driver" });
    expect(cache.forRoot("/repo")).toBeUndefined();
  });

  it("turns a port that rejects into a settled refusal instead of rejecting", async () => {
    const cache = new RustPassIndexCache<string, Acquisition>(async () => {
      throw new Error("boom");
    }, latched);
    await expect(cache.warm(plan({}))).resolves.toBeUndefined();
    expect(cache.lastAcquisition()).toEqual(latched("boom"));
  });

  it("does nothing without a port, a root or any expected Rust file", async () => {
    const acquire = vi.fn(async (): Promise<Acquisition> => ({ kind: "indexed", index: "x" }));
    await new RustPassIndexCache<string, Acquisition>(undefined, latched).warm(plan({}));
    const cache = new RustPassIndexCache<string, Acquisition>(acquire, latched);
    await cache.warm(plan({ projectRoot: undefined }));
    await cache.warm(plan({ expectedFileCount: 0 }));
    expect(acquire).not.toHaveBeenCalled();
    expect(cache.lastAcquisition()).toBeUndefined();
  });

  it("classifies test paths with the installed conventions by default", async () => {
    const seen: string[] = [];
    const cache = new RustPassIndexCache<string, Acquisition>(async ({ admission }) => {
      seen.push(admission(["src/lib.rs", "tests/it.rs"]));
      return { kind: "skipped", reason: "x" };
    }, latched);
    await cache.warm(plan({ expectedFileCount: 1 }));
    expect(seen).toHaveLength(1);
  });
});
