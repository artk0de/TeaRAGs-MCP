/**
 * WorkingTreeContentHashes — the content sha256 of a working-tree file,
 * memoized by the file's stat stamp `(size, mtimeMs, ctimeMs, inode)`, so a
 * delta asked on every request re-reads and re-hashes only the files whose
 * stamp moved; an unchanged file costs one `stat`. The chunk layer keys rows by
 * it and the tree-graph cache digests a delta with it.
 *
 * The hash is `fileContentHash` — sha256 of the file's TEXT (read as UTF-8),
 * the one definition the ingest synchronizers and the tree graph stamp rows
 * with. For valid UTF-8 it equals the sha256 of the bytes; bytes that are not
 * valid UTF-8 hash as their decoded text (what the chunker reads, too).
 *
 * Trade-off (the stamp rule):
 * an edit that keeps the size and lands within the filesystem's mtime AND ctime
 * granularity of the previous write, on the same inode, keeps the stamp and is
 * served the old hash until the next write moves it. Editors write whole files
 * seconds apart, and ctime moves on every write, so the window is a same-tick
 * rewrite of equal length.
 *
 * The memo is bounded by bytes (path + stamp + digest per file), least recently
 * used dropped first — the delta has no file cap, so a count bound would not
 * bound memory.
 */

import { promises as nodeFs } from "node:fs";

import { ByteBoundedLru } from "../../../infra/byte-bounded-lru.js";
import { fileContentHash } from "../../../infra/file-content-hash.js";

/**
 * Default bound of the memo: ~210 bytes per file for a 100-byte path, so
 * 64 MB holds ~300,000 files (the graph cache's content-hash memo sizes alike).
 */
export const WORKING_TREE_CONTENT_HASH_MEMO_BYTES = 64 * 1024 * 1024;

/** The two filesystem calls the memo makes — injectable so a caller can count or fake them. */
export interface WorkingTreeContentHashesFs {
  stat: (
    path: string,
  ) => Promise<{ isFile: () => boolean; size: number; mtimeMs: number; ctimeMs: number; ino: number }>;
  readFile: (path: string) => Promise<Buffer>;
}

export interface WorkingTreeContentHashesDeps {
  /** Memo bound in bytes; default {@link WORKING_TREE_CONTENT_HASH_MEMO_BYTES}. */
  maxBytes?: number;
  fs?: WorkingTreeContentHashesFs;
}

/** A tree file's bytes and their sha256, read together. */
export interface WorkingTreeFileContent {
  content: Buffer;
  sha256: string;
}

const defaultFs: WorkingTreeContentHashesFs = {
  stat: async (path) => nodeFs.stat(path),
  readFile: async (path) => nodeFs.readFile(path),
};

export class WorkingTreeContentHashes {
  private readonly memo: ByteBoundedLru<{ stamp: string; sha256: string }>;
  private readonly fs: WorkingTreeContentHashesFs;

  constructor(deps: WorkingTreeContentHashesDeps = {}) {
    this.memo = new ByteBoundedLru(deps.maxBytes ?? WORKING_TREE_CONTENT_HASH_MEMO_BYTES);
    this.fs = deps.fs ?? defaultFs;
  }

  /** Bytes the memo holds — the quantity its bound applies to. */
  get heldBytes(): number {
    return this.memo.heldBytes;
  }

  /**
   * The file's content sha256: from the memo while its stamp holds, else read
   * and hashed. Undefined when the path is not a readable regular file.
   */
  async sha256Of(path: string): Promise<string | undefined> {
    const stamp = await this.stampOf(path);
    if (stamp === undefined) return undefined;
    const memo = this.memo.get(path);
    if (memo?.stamp === stamp) return memo.sha256;
    return (await this.readStamped(path, stamp))?.sha256;
  }

  /**
   * The memo's hash while the file's stamp holds; undefined — without reading —
   * when the stamp moved, the path was never hashed, or it is not a regular
   * file. For a caller that reads the bytes itself on a miss
   * ({@link readContent}), so a changed file is read once, not twice.
   */
  async memoizedSha256Of(path: string): Promise<string | undefined> {
    const stamp = await this.stampOf(path);
    if (stamp === undefined) return undefined;
    const memo = this.memo.get(path);
    return memo?.stamp === stamp ? memo.sha256 : undefined;
  }

  /**
   * The file's bytes and their sha256, always read — for a caller that needs the
   * content itself (to chunk or store it). Seeds the memo, so a following
   * {@link sha256Of} does not read again. Undefined when not a readable regular file.
   */
  async readContent(path: string): Promise<WorkingTreeFileContent | undefined> {
    const stamp = await this.stampOf(path);
    return stamp === undefined ? undefined : this.readStamped(path, stamp);
  }

  /**
   * Reads after the stamp was taken: a write racing the read leaves a stamp
   * older than the file, so the next call sees it move and reads again.
   */
  private async readStamped(path: string, stamp: string): Promise<WorkingTreeFileContent | undefined> {
    const content = await this.fs.readFile(path).catch(() => undefined);
    if (!content) return undefined;
    const sha256 = fileContentHash(content.toString("utf8"));
    this.memo.set(path, { stamp, sha256 }, Buffer.byteLength(path) + stamp.length + sha256.length);
    return { content, sha256 };
  }

  private async stampOf(path: string): Promise<string | undefined> {
    const stat = await this.fs.stat(path).catch(() => undefined);
    if (!stat?.isFile()) return undefined;
    return `${String(stat.size)}:${String(stat.mtimeMs)}:${String(stat.ctimeMs)}:${String(stat.ino)}`;
  }
}
