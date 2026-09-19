/**
 * Raw NUL bytes in text files (bd tea-rags-mcp-k8gac) — the detector shared by
 * the tracked-tree guard (`tests/source-nul-bytes.test.ts`) and the per-commit
 * check the pre-commit hook runs (`scripts/check-staged-nul-bytes.ts`).
 *
 * A NUL in a text file makes git treat it as binary: `git diff` prints `Bin`,
 * `git log --numstat` gives `-\t-`, TeaRAGs' line-churn signals vanish for it,
 * and ripgrep skips it. The usual origin is a file-write tool call whose JSON
 * decoding turns a typed unicode escape for code point zero into the byte.
 */

import { execFileSync } from "node:child_process";
import { extname } from "node:path";

const NUL = 0x00;
const LINE_FEED = 0x0a;
const NUL_SEPARATOR = "\0";

export interface NulByteOffense {
  /** 1-based line holding the byte. */
  line: number;
  /** 1-based byte column of the byte within that line. */
  column: number;
}

/** A {@link NulByteOffense} in a named repository file. */
export interface LocatedNulByteOffense extends NulByteOffense {
  /** Repo-relative path, POSIX separators. */
  path: string;
}

/** How to fix one — the escape is the same runtime value and keeps the file text. */
export const NUL_BYTE_FIX_HINT = String.raw`git treats each file as binary — use "\0" (or "\x00" before a digit)`;

/** Every raw NUL byte in `content`, in file order. */
export function findRawNulBytes(content: Uint8Array): NulByteOffense[] {
  const offenses: NulByteOffense[] = [];
  let line = 1;
  let lineStart = 0;
  for (let offset = 0; offset < content.length; offset++) {
    const byte = content[offset];
    if (byte === NUL) offenses.push({ line, column: offset - lineStart + 1 });
    if (byte === LINE_FEED) {
      line++;
      lineStart = offset + 1;
    }
  }
  return offenses;
}

/** `path line L, byte C` — one place to fix. */
export function describeNulByteOffense(offense: LocatedNulByteOffense): string {
  return `${offense.path} line ${offense.line}, byte ${offense.column}`;
}

/**
 * Formats whose NUL bytes are content: images, fonts, documents, archives,
 * media, compiled objects, databases, model weights.
 */
const BINARY_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  ...["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "tif", "tiff", "ico", "icns", "heic"],
  ...["woff", "woff2", "ttf", "otf", "eot"],
  ...["pdf", "zip", "gz", "tgz", "bz2", "xz", "zst", "7z", "tar", "jar"],
  ...["mp3", "mp4", "m4a", "mov", "webm", "wav", "ogg", "flac"],
  ...["wasm", "node", "so", "dylib", "dll", "exe", "o", "a", "class", "pyc"],
  ...["db", "sqlite", "duckdb", "wal", "onnx", "bin", "npy"],
]);

/**
 * Whether the NUL guards cover `path`: every file except a known binary
 * format, decided by extension.
 *
 * Git's own classification (`git ls-files --eol` reporting `-text`) cannot be
 * used: git calls a file binary when it FINDS a NUL in its first 8000 bytes, so
 * it would exempt exactly the file the guard exists to catch. The repository
 * tracks binaries only as images today (`public/logo.png` and the website's
 * favicon and logo); the list covers the formats a checkout plausibly adds.
 */
export function isNulGuardedPath(path: string): boolean {
  return !BINARY_FILE_EXTENSIONS.has(extname(path).slice(1).toLowerCase());
}

/** Git's mode for a gitlink: its "blob" id names a commit of another repository. */
const GITLINK_MODE = "160000";

/** Enough for any staged blob set this repository commits; `execFileSync` defaults to 1 MiB. */
const GIT_OUTPUT_LIMIT_BYTES = 1024 * 1024 * 1024;

interface StagedBlob {
  path: string;
  blobId: string;
}

/**
 * The blobs a commit made now would add or change, repo-relative — the index,
 * including a `GIT_INDEX_FILE` the hook runs under. Rename detection is off,
 * so a rename is reported as the path it lands on.
 */
function stagedTextBlobs(root: string): StagedBlob[] {
  const raw = execFileSync(
    "git",
    [
      "diff",
      "--cached",
      "--raw",
      "-z",
      "--no-abbrev",
      "--no-renames",
      "--no-color",
      "--no-ext-diff",
      "--diff-filter=ACMR",
    ],
    { cwd: root, encoding: "utf8", maxBuffer: GIT_OUTPUT_LIMIT_BYTES },
  );
  // `-z` record: ":<src mode> <dst mode> <src id> <dst id> <status>" NUL "<path>" NUL.
  const fields = raw.split(NUL_SEPARATOR);
  const blobs: StagedBlob[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [, dstMode, , dstId] = fields[i].slice(1).split(" ");
    const path = fields[i + 1];
    if (dstMode === GITLINK_MODE || !isNulGuardedPath(path)) continue;
    blobs.push({ path, blobId: dstId });
  }
  return blobs;
}

/**
 * The contents of `blobIds`, in order, through ONE `git cat-file --batch`.
 * Its output per object is "<id> <type> <size>" LF, the bytes, then LF.
 */
function readBlobs(root: string, blobIds: readonly string[]): Buffer[] {
  const output = execFileSync("git", ["cat-file", "--batch"], {
    cwd: root,
    input: `${blobIds.join("\n")}\n`,
    maxBuffer: GIT_OUTPUT_LIMIT_BYTES,
  });
  const contents: Buffer[] = [];
  let offset = 0;
  for (const blobId of blobIds) {
    const headerEnd = output.indexOf(LINE_FEED, offset);
    const header = output.subarray(offset, headerEnd).toString("utf8").split(" ");
    if (header[1] !== "blob") {
      // Programming error: the index names only objects the repository holds.
      throw new Error(`git cat-file could not read staged blob ${blobId}: ${header.join(" ")}`);
    }
    const start = headerEnd + 1;
    const end = start + Number(header[2]);
    contents.push(output.subarray(start, end));
    offset = end + 1;
  }
  return contents;
}

/**
 * Every raw NUL byte in the text files the next commit would record, in path
 * order. Reads the STAGED blobs, not the working tree: that is what the commit
 * carries, whatever the files on disk say now.
 */
export function findStagedNulBytes(root: string): LocatedNulByteOffense[] {
  const blobs = stagedTextBlobs(root);
  if (blobs.length === 0) return [];
  const contents = readBlobs(
    root,
    blobs.map((blob) => blob.blobId),
  );
  return blobs
    .flatMap((blob, i) => findRawNulBytes(contents[i]).map((offense) => ({ path: blob.path, ...offense })))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
