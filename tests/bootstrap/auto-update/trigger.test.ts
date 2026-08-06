import { describe, expect, it, vi } from "vitest";

import { AutoUpdateTrigger } from "../../../src/bootstrap/auto-update/trigger.js";
import type { CollectionEntry, IndexFreshnessVerdict } from "../../../src/core/api/public/index.js";

const NOW = 1_700_000_000_000;

const entry: CollectionEntry = {
  collectionName: "code_x",
  path: "/repo/x",
  name: "proj",
  embeddingModel: "m",
  embeddingDimensions: 384,
  qdrantUrl: "http://localhost:6333",
  indexedAt: "2026-08-06T00:00:00.000Z",
  teaRagsVersion: "1.0.0",
  chunksCount: 10,
  autoUpdate: { enabled: true, targetBranch: "master" },
};

function trigger(over: {
  spawn?: (project: string) => void;
  verdict?: IndexFreshnessVerdict;
  get?: (name: string) => CollectionEntry | null;
  clock?: () => number;
}) {
  return new AutoUpdateTrigger({
    registry: { get: over.get ?? (() => entry) },
    freshness: { check: () => over.verdict ?? { kind: "eligible", entry } },
    spawn: over.spawn ?? (() => {}),
    clock: over.clock ?? (() => NOW),
  });
}

describe("AutoUpdateTrigger.maybeSpawn", () => {
  it("spawns on eligible and remembers the in-memory TTL", () => {
    const spawn = vi.fn();
    const t = trigger({ spawn });
    expect(t.maybeSpawn("code_x")).toBe("eligible");
    expect(spawn).toHaveBeenCalledWith("code_x");
    expect(t.maybeSpawn("code_x")).toBe("in-memory-debounced");
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("does not spawn on branch-mismatch but reports the kind", () => {
    const spawn = vi.fn();
    const t = trigger({
      spawn,
      verdict: { kind: "branch-mismatch", head: "feature-x", targetBranch: "master" },
    });
    expect(t.maybeSpawn("code_x")).toBe("branch-mismatch");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("non-eligible verdicts also enter the in-memory TTL (no re-check storm)", () => {
    const t = trigger({ verdict: { kind: "disabled" } });
    expect(t.maybeSpawn("code_x")).toBe("disabled");
    expect(t.maybeSpawn("code_x")).toBe("in-memory-debounced");
  });

  it("TTL expires after 120s and the check runs again", () => {
    let now = NOW;
    const spawn = vi.fn();
    const t = trigger({ spawn, clock: () => now });
    t.maybeSpawn("code_x");
    now += 121_000;
    expect(t.maybeSpawn("code_x")).toBe("eligible");
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("TTL is per collection", () => {
    const spawn = vi.fn();
    const t = trigger({ spawn });
    t.maybeSpawn("code_x");
    expect(t.maybeSpawn("code_other")).toBe("eligible");
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("unknown collection reports disabled, no spawn, no throw", () => {
    const spawn = vi.fn();
    const t = trigger({ spawn, get: () => null });
    expect(t.maybeSpawn("nope")).toBe("disabled");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("a throwing spawn never propagates (fire-and-forget contract)", () => {
    const t = trigger({
      spawn: () => {
        throw new Error("spawn EPERM");
      },
    });
    expect(() => t.maybeSpawn("code_x")).not.toThrow();
  });
});
