/**
 * Per-language code-version stamping in the registry (bd tea-rags-mcp-frwka).
 *
 * The stamp records WHICH revision of our per-language machinery produced the
 * indexed data, so it must advance only on a run that actually rebuilt that
 * layer. A plain incremental reindex calls `record()` like every other run, so
 * the field has to be sticky — otherwise the next auto-update quietly erases
 * the evidence that the index is behind the code.
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

describe("CollectionRegistry — language version stamp", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "creg-lv-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("stampLanguageVersions writes the stamp and persists it across instances", () => {
    const r = new CollectionRegistry(dir);
    r.record(makeEntry());
    r.stampLanguageVersions("code_abc", { ruby: { grammar: "0.23.1", chunking: 1, walker: 1, codegraphSchema: 1 } });

    expect(new CollectionRegistry(dir).get("code_abc")?.languageVersions).toEqual({
      ruby: { grammar: "0.23.1", chunking: 1, walker: 1, codegraphSchema: 1 },
    });
  });

  it("survives a later record() — an incremental reindex must not erase it", () => {
    const r = new CollectionRegistry(dir);
    r.record(makeEntry());
    r.stampLanguageVersions("code_abc", { ruby: { chunking: 1, walker: 1, codegraphSchema: 1 } });

    r.record(makeEntry({ chunksCount: 99 }));

    expect(r.get("code_abc")?.chunksCount).toBe(99);
    expect(r.get("code_abc")?.languageVersions).toEqual({ ruby: { chunking: 1, walker: 1, codegraphSchema: 1 } });
  });

  it("merges per axis — a codegraph recompute advances edges without claiming the chunk set moved", () => {
    const r = new CollectionRegistry(dir);
    r.record(makeEntry());
    r.stampLanguageVersions("code_abc", {
      typescript: { grammar: "0.23.2", chunking: 1, walker: 1, codegraphSchema: 1 },
    });

    r.stampLanguageVersions("code_abc", { typescript: { walker: 2, codegraphSchema: 1 } });

    expect(r.get("code_abc")?.languageVersions?.typescript).toEqual({
      grammar: "0.23.2",
      chunking: 1,
      walker: 2,
      codegraphSchema: 1,
    });
  });

  it("merges per language — stamping one language leaves the others alone", () => {
    const r = new CollectionRegistry(dir);
    r.record(makeEntry());
    r.stampLanguageVersions("code_abc", {
      ruby: { chunking: 1, walker: 1, codegraphSchema: 1 },
      typescript: { chunking: 1, walker: 1, codegraphSchema: 1 },
    });

    r.stampLanguageVersions("code_abc", { typescript: { walker: 2 } });

    expect(r.get("code_abc")?.languageVersions?.ruby).toEqual({ chunking: 1, walker: 1, codegraphSchema: 1 });
    expect(r.get("code_abc")?.languageVersions?.typescript?.walker).toBe(2);
  });

  it("is a no-op for an unregistered collection rather than throwing", () => {
    const r = new CollectionRegistry(dir);

    expect(() => {
      r.stampLanguageVersions("code_missing", { ruby: { chunking: 1 } });
    }).not.toThrow();
    expect(r.get("code_missing")).toBeNull();
  });
});
