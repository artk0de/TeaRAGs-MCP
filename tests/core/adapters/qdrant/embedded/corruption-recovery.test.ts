/**
 * Corrupt-collection self-heal (tea-rags-mcp-mh7nr).
 *
 * A killed force-reindex leaves a half-written versioned collection whose WAL
 * replay hits an out-of-bounds segment. On the NEXT boot, qdrant panics during
 * `TableOfContent::new` while loading that shard — which brings down the ENTIRE
 * daemon (one corrupt collection fails the load of all 47), so every later
 * index/query gets a bare "fetch failed". The 55xk2 orphan-sweep cannot help:
 * it runs INSIDE a reindex, but the daemon never boots to run one.
 *
 * These pin the two pure pieces of the recovery: reading the corrupt
 * collection's name out of the captured crash log, and moving it aside.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  parseCorruptCollection,
  quarantineCorruptCollection,
} from "../../../../../src/core/adapters/qdrant/embedded/corruption-recovery.js";

// The exact panic qdrant 1.17 prints (captured from the taxdome monolith,
// 2026-07-05) when the killed-reindex leftover code_27622aef_v35 is loaded.
const REAL_PANIC = [
  "ERROR collection::shards::local_shard: Can't apply WAL operation: elements range 4915200..4918272 is out of bounds, file contains 1228800 elements, collection: code_27622aef_v35, shard: /Users/artk0re/.tea-rags/qdrant/collections/code_27622aef_v35/0, op_num: 183",
  'ERROR qdrant::startup: Panic occurred in file lib/collection/src/shards/replica_set/mod.rs at line 312: Failed to load local shard "/Users/artk0re/.tea-rags/qdrant/collections/code_27622aef_v35/0": Service internal error: elements range 4915200..4918272 is out of bounds, file contains 1228800 elements',
].join("\n");

describe("parseCorruptCollection", () => {
  it("extracts the collection name from qdrant's real shard-load panic", () => {
    expect(parseCorruptCollection(REAL_PANIC)).toBe("code_27622aef_v35");
  });

  it("returns null for a healthy boot log (no false quarantine)", () => {
    const healthy = [
      "INFO qdrant::startup: Qdrant HTTP listening on 127.0.0.1:6333",
      "INFO storage::content_manager::toc: Loaded collection code_abc_v1",
    ].join("\n");
    expect(parseCorruptCollection(healthy)).toBeNull();
  });

  it("returns null for a connection/transient error that is NOT a shard-load panic", () => {
    expect(parseCorruptCollection("ERROR qdrant: address already in use (os error 48)")).toBeNull();
  });

  it("tolerates Windows-style separators in the shard path", () => {
    const winPanic =
      'Failed to load local shard "C:\\tea-rags\\qdrant\\collections\\code_win_v3\\0": Service internal error';
    expect(parseCorruptCollection(winPanic)).toBe("code_win_v3");
  });
});

describe("quarantineCorruptCollection", () => {
  let storage: string;

  beforeEach(() => {
    storage = mkdtempSync(join(tmpdir(), "corrupt-recovery-"));
    mkdirSync(join(storage, "collections", "code_bad_v35", "0"), { recursive: true });
    writeFileSync(join(storage, "collections", "code_bad_v35", "0", "segment"), "corrupt");
    // a healthy neighbour that must stay put
    mkdirSync(join(storage, "collections", "code_good_v1"), { recursive: true });
  });

  afterEach(() => {
    rmSync(storage, { recursive: true, force: true });
  });

  it("moves the corrupt collection into .corrupt/ (reversible, not deleted) and leaves neighbours untouched", () => {
    const dest = quarantineCorruptCollection(storage, "code_bad_v35", 1782300000000);

    expect(existsSync(join(storage, "collections", "code_bad_v35"))).toBe(false);
    expect(existsSync(dest)).toBe(true);
    expect(existsSync(join(dest, "0", "segment"))).toBe(true); // moved, not dropped
    expect(dest).toContain(".corrupt");
    // neighbour untouched → qdrant boots with it next time
    expect(existsSync(join(storage, "collections", "code_good_v1"))).toBe(true);
    expect(readdirSync(join(storage, "collections"))).toEqual(["code_good_v1"]);
  });

  it("throws when the named collection does not exist (caller treats as non-recoverable)", () => {
    expect(() => quarantineCorruptCollection(storage, "code_absent_v9", 1782300000000)).toThrow();
  });
});
