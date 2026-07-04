import { describe, expect, it } from "vitest";

import { CommitDiffMemo } from "../../../src/core/infra/commit-diff-memo.js";

const hunk = (n: number) => ({ oldStart: n, oldLines: 1, newStart: n, newLines: 1 });

describe("CommitDiffMemo (bd tea-rags-mcp-7gnre)", () => {
  it("returns undefined for a missing entry and roundtrips set/get", () => {
    const memo = new CommitDiffMemo();
    expect(memo.get("sha1", "a.ts")).toBeUndefined();
    memo.set("sha1", "a.ts", [hunk(1), hunk(5)]);
    expect(memo.get("sha1", "a.ts")).toEqual([hunk(1), hunk(5)]);
  });

  it("distinguishes a memoized-empty diff ([]) from a missing entry (undefined)", () => {
    const memo = new CommitDiffMemo();
    memo.set("sha1", "a.ts", []);
    expect(memo.get("sha1", "a.ts")).toEqual([]);
    expect(memo.get("sha1", "b.ts")).toBeUndefined();
  });

  it("keys entries by (commitSha, filePath) — same sha, different files are distinct", () => {
    const memo = new CommitDiffMemo();
    memo.set("sha1", "a.ts", [hunk(1)]);
    memo.set("sha1", "b.ts", [hunk(2)]);
    expect(memo.get("sha1", "a.ts")).toEqual([hunk(1)]);
    expect(memo.get("sha1", "b.ts")).toEqual([hunk(2)]);
  });

  it("never exceeds the entry cap — oldest entry evicted on overflow", () => {
    const memo = new CommitDiffMemo(2);
    memo.set("c1", "a.ts", [hunk(1)]);
    memo.set("c2", "a.ts", [hunk(2)]);
    memo.set("c3", "a.ts", [hunk(3)]);
    expect(memo.size).toBe(2);
    expect(memo.get("c1", "a.ts")).toBeUndefined();
    expect(memo.get("c2", "a.ts")).toEqual([hunk(2)]);
    expect(memo.get("c3", "a.ts")).toEqual([hunk(3)]);
  });

  it("get() refreshes recency — least-recently-USED entry is evicted, not oldest-inserted", () => {
    const memo = new CommitDiffMemo(2);
    memo.set("c1", "a.ts", [hunk(1)]);
    memo.set("c2", "a.ts", [hunk(2)]);
    memo.get("c1", "a.ts"); // refresh c1 → c2 becomes LRU
    memo.set("c3", "a.ts", [hunk(3)]);
    expect(memo.get("c2", "a.ts")).toBeUndefined();
    expect(memo.get("c1", "a.ts")).toEqual([hunk(1)]);
    expect(memo.get("c3", "a.ts")).toEqual([hunk(3)]);
  });

  it("re-setting an existing key does not evict and does not grow size", () => {
    const memo = new CommitDiffMemo(2);
    memo.set("c1", "a.ts", [hunk(1)]);
    memo.set("c2", "a.ts", [hunk(2)]);
    memo.set("c1", "a.ts", [hunk(9)]);
    expect(memo.size).toBe(2);
    expect(memo.get("c1", "a.ts")).toEqual([hunk(9)]);
    expect(memo.get("c2", "a.ts")).toEqual([hunk(2)]);
  });
});
