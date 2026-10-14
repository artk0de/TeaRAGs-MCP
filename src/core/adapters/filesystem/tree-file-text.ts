import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

/**
 * Above this size a file is not a configuration file a path literal is read
 * from (bd tea-rags-mcp-r8hme.52.19); it is skipped rather than read whole.
 */
const MAX_TREE_FILE_TEXT_BYTES = 256 * 1024;

/**
 * One file's text in a working tree, by its repo-relative path (bd
 * tea-rags-mcp-r8hme.52.19) — the architecture report reads path literals of
 * the few files it already classified as development roots. Total: a path
 * escaping the root, a missing, unreadable or oversized file reads as
 * `undefined`.
 */
export function readTreeFileText(root: string, relPath: string): string | undefined {
  const path = join(root, relPath);
  const relativePath = relative(root, path);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) return undefined;
  try {
    if (statSync(path).size > MAX_TREE_FILE_TEXT_BYTES) return undefined;
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}
