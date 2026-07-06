/**
 * bd tea-rags-mcp-v2mlw — GitBlameStore: persistent OID-keyed blame lines,
 * normalized on disk (commit table dedupes author/email/timestamp per sha).
 * Pins: save→load roundtrip reconstructs BlameLine[] exactly (incl. shared-sha
 * dedupe across files), corrupt JSON → null, repoRoot mismatch → null
 * (hash-collision guard), tiny maxBytes → save skipped, cold dir → null.
 * No git needed — synthetic BlameLine arrays against an explicit tmp baseDir.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { BlameLine } from "../../../../../../src/core/adapters/vcs/types.js";
import { GitBlameStore } from "../../../../../../src/core/domains/trajectory/git/infra/blame-store.js";

const SHA_1 = "a".repeat(40);
const SHA_2 = "b".repeat(40);

function line(lineNumber: number, sha: string, author: string): BlameLine {
  return { lineNumber, sha, author, authorEmail: `${author}@example.com`, timestamp: 1700000000 + lineNumber };
}

describe("GitBlameStore (bd tea-rags-mcp-v2mlw)", () => {
  let baseDir: string;
  const repoRoot = "/repos/alpha";

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "blame-store-"));
  });
  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  function fixtureFiles(): Map<string, { oid: string; lines: BlameLine[] }> {
    // SHA_1 lines share one commit identity across BOTH files — the persisted
    // commit table must dedupe it and the load must reconstruct it per line.
    const l1 = { lineNumber: 1, sha: SHA_1, author: "Alice", authorEmail: "Alice@example.com", timestamp: 1700000001 };
    const l2 = { lineNumber: 2, sha: SHA_2, author: "Bob", authorEmail: "Bob@example.com", timestamp: 1700000002 };
    const l3 = { lineNumber: 1, sha: SHA_1, author: "Alice", authorEmail: "Alice@example.com", timestamp: 1700000001 };
    return new Map([
      ["src/a.ts", { oid: "1".repeat(40), lines: [l1, l2] }],
      ["src/b.ts", { oid: "2".repeat(40), lines: [l3] }],
    ]);
  }

  it("save → load roundtrip deep-equals the input map (shared-sha dedupe reconstructed)", () => {
    const store = new GitBlameStore(baseDir);
    const files = fixtureFiles();
    store.save(repoRoot, files);

    const loaded = store.load(repoRoot);
    expect(loaded).not.toBeNull();
    expect(loaded?.size).toBe(2);
    expect(loaded?.get("src/a.ts")).toEqual(files.get("src/a.ts"));
    expect(loaded?.get("src/b.ts")).toEqual(files.get("src/b.ts"));
  });

  it("load of corrupt JSON returns null (silent rebuild)", () => {
    const store = new GitBlameStore(baseDir);
    store.save(repoRoot, fixtureFiles());
    const path = locateBlameJson(baseDir);
    writeFileSync(path, "{ not json at all");

    expect(store.load(repoRoot)).toBeNull();
  });

  it("load with a mismatched persisted repoRoot returns null (hash-collision guard)", () => {
    const store = new GitBlameStore(baseDir);
    store.save(repoRoot, fixtureFiles());
    const path = locateBlameJson(baseDir);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { repoRoot: string };
    parsed.repoRoot = "/repos/omega";
    writeFileSync(path, JSON.stringify(parsed));

    expect(store.load(repoRoot)).toBeNull();
  });

  it("load with a missing referenced sha in the commit table returns null", () => {
    const store = new GitBlameStore(baseDir);
    store.save(repoRoot, fixtureFiles());
    const path = locateBlameJson(baseDir);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { commits: Record<string, unknown> };
    delete parsed.commits[SHA_2];
    writeFileSync(path, JSON.stringify(parsed));

    expect(store.load(repoRoot)).toBeNull();
  });

  // Structural validation: any snapshot whose shape breaks the persisted
  // contract must load as null (silent rebuild), never as partial/garbage data.
  type LooseSnapshot = {
    version: number;
    repoRoot: string;
    commits: Record<string, unknown>;
    files: Record<string, { oid: unknown; lines: unknown }>;
  };
  const withFileA = (p: LooseSnapshot, patch: Partial<{ oid: unknown; lines: unknown }>): LooseSnapshot => ({
    ...p,
    files: { ...p.files, "src/a.ts": { ...p.files["src/a.ts"], ...patch } },
  });
  it.each<[string, (p: LooseSnapshot) => unknown]>([
    ["a non-object snapshot", () => 42],
    ["a version other than 1", (p) => ({ ...p, version: 2 })],
    ["a non-object commits table", (p) => ({ ...p, commits: "nope" })],
    ["a non-object files table", (p) => ({ ...p, files: "nope" })],
    ["a malformed commit entry", (p) => ({ ...p, commits: { ...p.commits, [SHA_1]: "nope" } })],
    ["a non-object file entry", (p) => ({ ...p, files: { ...p.files, "src/a.ts": "nope" } })],
    ["a file oid that is not a string", (p) => withFileA(p, { oid: 5 })],
    ["a file lines field that is not an array", (p) => withFileA(p, { lines: "nope" })],
    ["a malformed line pair (sha not a string)", (p) => withFileA(p, { lines: [[1, 2]] })],
  ])("load rejects %s → null (silent rebuild)", (_label, mutate) => {
    const store = new GitBlameStore(baseDir);
    store.save(repoRoot, fixtureFiles());
    const path = locateBlameJson(baseDir);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as LooseSnapshot;
    writeFileSync(path, JSON.stringify(mutate(parsed)));

    expect(store.load(repoRoot)).toBeNull();
  });

  it("oversized payload skips the save (tiny maxBytes → nothing persisted)", () => {
    const store = new GitBlameStore(baseDir, 8);
    store.save(repoRoot, fixtureFiles());

    expect(store.load(repoRoot)).toBeNull();
  });

  it("cold load (nothing ever saved) returns null", () => {
    const store = new GitBlameStore(baseDir);
    expect(store.load(repoRoot)).toBeNull();
  });

  it("save with lines added by only one author still roundtrips a single-line file", () => {
    const store = new GitBlameStore(baseDir);
    const files = new Map([["solo.ts", { oid: "3".repeat(40), lines: [line(1, SHA_1, "Alice")] }]]);
    store.save(repoRoot, files);

    expect(store.load(repoRoot)?.get("solo.ts")).toEqual(files.get("solo.ts"));
  });
});

/** The store writes ONE blame.json under <baseDir>/<hash16>/ — find it. */
function locateBlameJson(baseDir: string): string {
  const [hashDir] = readdirSync(baseDir);
  return join(baseDir, hashDir, "blame.json");
}
