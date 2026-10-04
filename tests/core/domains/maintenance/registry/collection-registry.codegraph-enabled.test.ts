/**
 * The codegraphEnabled stamp in the registry (bd tea-rags-mcp-5m8g3).
 *
 * `resolveRegistryEnv` replays the dedicated `codegraphEnabled` field into
 * `CODEGRAPH_ENABLED`, and an entry that predates the field carries no value at
 * all — such an entry composes without the codegraph tools at call time even
 * though its index holds a full graph. A full pipeline run stamps the field
 * through `recordRegistryEntry`, but an enrichment recompute never reaches it,
 * so the recompute stamps the field itself; these tests pin the registry side
 * of that write.
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

describe("CollectionRegistry — codegraphEnabled stamp", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "creg-cg-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("stampCodegraphEnabled writes true and persists it across instances", () => {
    const r = new CollectionRegistry(dir);
    r.record(makeEntry());
    r.stampCodegraphEnabled("code_abc");

    expect(new CollectionRegistry(dir).get("code_abc")?.codegraphEnabled).toBe(true);
  });

  it("overwrites an explicit false — the run that rebuilt the graph outranks the older decision", () => {
    // Same semantics as a full run: `projects set-env` holds "until the
    // ambient env of a run overrides it" (ProjectRegistryOps#editEnv), and a
    // codegraph recompute composed ON is exactly that override.
    const r = new CollectionRegistry(dir);
    r.record(makeEntry({ codegraphEnabled: false }));
    r.stampCodegraphEnabled("code_abc");

    expect(r.get("code_abc")?.codegraphEnabled).toBe(true);
  });

  it("leaves the rest of the entry untouched", () => {
    const r = new CollectionRegistry(dir);
    r.record(makeEntry({ languageVersions: { ruby: { chunking: 1 } } }));
    // `name` never travels through record() — it is sticky, set by setName.
    r.setName("code_abc", "proj");
    r.stampCodegraphEnabled("code_abc");

    const entry = r.get("code_abc");
    expect(entry?.name).toBe("proj");
    expect(entry?.languageVersions).toEqual({ ruby: { chunking: 1 } });
    expect(entry?.chunksCount).toBe(10);
  });

  it("is a no-op for an unregistered collection rather than throwing", () => {
    const r = new CollectionRegistry(dir);

    expect(() => {
      r.stampCodegraphEnabled("code_missing");
    }).not.toThrow();
    expect(r.get("code_missing")).toBeNull();
  });
});
