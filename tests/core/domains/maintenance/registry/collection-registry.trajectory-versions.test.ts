/**
 * Per-provider algorithm-version stamping in the registry (bd tea-rags-mcp-xi2r9).
 *
 * The stamp claims a provider's payload was rebuilt for every point by the
 * recorded revision of its algorithm, so — like `languageVersions` — it must
 * survive the `record()` every run makes, incremental ones included.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CollectionEntry } from "../../../../../src/core/contracts/types/registry.js";
import { CollectionRegistry } from "../../../../../src/core/domains/maintenance/registry/collection-registry.js";

function makeEntry(over: Partial<CollectionEntry> = {}): Omit<CollectionEntry, "name"> {
  return {
    collectionName: "code_abc",
    path: "/repo/a",
    embeddingModel: "m",
    embeddingDimensions: 384,
    qdrantUrl: "http://localhost:6333",
    indexedAt: "2026-05-12T00:00:00.000Z",
    teaRagsVersion: "0.1.0",
    chunksCount: 10,
    ...over,
  };
}

describe("CollectionRegistry — trajectory version stamp", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "creg-tv-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the stamp and persists it across instances", () => {
    const registry = new CollectionRegistry(dir);
    registry.record(makeEntry());
    registry.stampTrajectoryVersions("code_abc", { git: 2 });

    expect(new CollectionRegistry(dir).get("code_abc")?.trajectoryVersions).toEqual({ git: 2 });
  });

  it("survives a later record() — an incremental reindex must not erase it", () => {
    const registry = new CollectionRegistry(dir);
    registry.record(makeEntry());
    registry.stampTrajectoryVersions("code_abc", { git: 2 });

    registry.record(makeEntry({ chunksCount: 99 }));

    expect(registry.get("code_abc")?.trajectoryVersions).toEqual({ git: 2 });
  });

  it("merges per provider", () => {
    const registry = new CollectionRegistry(dir);
    registry.record(makeEntry());
    registry.stampTrajectoryVersions("code_abc", { git: 2, other: 4 });

    registry.stampTrajectoryVersions("code_abc", { git: 3 });

    expect(registry.get("code_abc")?.trajectoryVersions).toEqual({ git: 3, other: 4 });
  });

  it("ignores an unregistered collection", () => {
    const registry = new CollectionRegistry(dir);

    registry.stampTrajectoryVersions("code_missing", { git: 2 });

    expect(registry.get("code_missing")).toBeNull();
  });
});
