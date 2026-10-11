/**
 * In-memory collections — primitives layer (`core/primitives/`), I/O-free and
 * importable by every core layer. Consumers import this barrel, never a file
 * behind it.
 */

export { ByteBoundedLru } from "./byte-bounded-lru.js";
export { CommitDiffMemo, type CommitDiffHunk } from "./commit-diff-memo.js";
