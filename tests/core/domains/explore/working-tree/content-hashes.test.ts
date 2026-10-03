/**
 * `WorkingTreeContentHashes`: a tree file's content sha256, memoized by its
 * stat stamp `(size, mtime, ctime, inode)` so a delta asked on every request
 * re-reads only the files whose stamp moved.
 */

import { createHash } from "node:crypto";
import { promises as fs, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WorkingTreeContentHashes } from "../../../../../src/core/domains/explore/working-tree/index.js";
import { fileContentHash } from "../../../../../src/core/infra/file-content-hash.js";

const sha256 = (content: string): string => createHash("sha256").update(content).digest("hex");

describe("WorkingTreeContentHashes", () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `wt-content-hashes-${String(process.pid)}-${String(Math.random()).slice(2)}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Hashes over the real filesystem, with every `readFile` counted. */
  const counted = (maxBytes?: number) => {
    const readFile = vi.fn(async (path: string) => fs.readFile(path));
    const hashes = new WorkingTreeContentHashes({ fs: { stat: async (path) => fs.stat(path), readFile }, maxBytes });
    return { hashes, readFile };
  };

  it("should hash a file once and answer again from the memo while its stamp holds", async () => {
    const path = join(dir, "a.ts");
    writeFileSync(path, "export const a = 1;\n");
    const { hashes, readFile } = counted();

    expect(await hashes.sha256Of(path)).toBe(sha256("export const a = 1;\n"));
    expect(await hashes.sha256Of(path)).toBe(sha256("export const a = 1;\n"));

    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it("should re-read a file whose stamp moved", async () => {
    const path = join(dir, "a.ts");
    writeFileSync(path, "export const a = 1;\n");
    const { hashes, readFile } = counted();
    await hashes.sha256Of(path);

    writeFileSync(path, "export const a = 22; // edited\n");

    expect(await hashes.sha256Of(path)).toBe(sha256("export const a = 22; // edited\n"));
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  // One definition with the ingest synchronizers and the tree graph's stamps:
  // the hash of the file's TEXT. Equal to the bytes' sha256 for valid UTF-8.
  it("should hash the file's text as `fileContentHash` does, also for bytes that are not valid UTF-8", async () => {
    const path = join(dir, "latin1.ts");
    const bytes = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]); // "café\n" in Latin-1
    writeFileSync(path, bytes);
    const { hashes } = counted();

    expect(await hashes.sha256Of(path)).toBe(fileContentHash(bytes.toString("utf8")));
    expect((await hashes.readContent(path))?.sha256).toBe(fileContentHash(bytes.toString("utf8")));
    expect((await hashes.readContent(path))?.content).toEqual(bytes);
  });

  it("should answer undefined for a path that is not a readable regular file", async () => {
    mkdirSync(join(dir, "sub"));
    const { hashes, readFile } = counted();

    expect(await hashes.sha256Of(join(dir, "missing.ts"))).toBeUndefined();
    expect(await hashes.sha256Of(join(dir, "sub"))).toBeUndefined();
    expect(readFile).not.toHaveBeenCalled();
  });

  it("should read content with its hash and seed the memo with it", async () => {
    const path = join(dir, "a.ts");
    writeFileSync(path, "export const a = 1;\n");
    const { hashes, readFile } = counted();

    const read = await hashes.readContent(path);
    expect(read?.content.toString("utf8")).toBe("export const a = 1;\n");
    expect(read?.sha256).toBe(sha256("export const a = 1;\n"));
    expect(await hashes.sha256Of(path)).toBe(read?.sha256);

    expect(readFile).toHaveBeenCalledTimes(1);
    expect(await hashes.readContent(join(dir, "missing.ts"))).toBeUndefined();
  });

  it("should answer a memoized hash without reading, and nothing for a file it must read", async () => {
    const path = join(dir, "a.ts");
    writeFileSync(path, "export const a = 1;\n");
    const { hashes, readFile } = counted();

    expect(await hashes.memoizedSha256Of(path)).toBeUndefined();
    await hashes.readContent(path);
    expect(await hashes.memoizedSha256Of(path)).toBe(sha256("export const a = 1;\n"));
    writeFileSync(path, "export const a = 22; // edited\n");
    expect(await hashes.memoizedSha256Of(path)).toBeUndefined();
    expect(await hashes.memoizedSha256Of(join(dir, "missing.ts"))).toBeUndefined();

    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it("should hold no more memo bytes than its bound, dropping the least recently used path", async () => {
    const paths = ["a.ts", "b.ts", "c.ts"].map((name) => join(dir, name));
    for (const path of paths) writeFileSync(path, `export const v = "${path}";\n`);
    // One entry: the path's bytes + the stamp + 64 hex digits; the bound fits two.
    const { hashes: probe } = counted();
    await probe.sha256Of(paths[0]);
    const { hashes, readFile } = counted(probe.heldBytes * 2 + 1);

    for (const path of paths) await hashes.sha256Of(path);
    expect(hashes.heldBytes).toBeLessThanOrEqual(probe.heldBytes * 2 + 1);

    await hashes.sha256Of(paths[2]);
    expect(readFile).toHaveBeenCalledTimes(3); // c.ts still held
    await hashes.sha256Of(paths[0]);
    expect(readFile).toHaveBeenCalledTimes(4); // a.ts was dropped
  });
});
