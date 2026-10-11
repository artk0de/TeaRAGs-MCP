/**
 * Reads a file and hashes it under the one content-hash contract
 * (`primitives/ids/content-hash.ts`) — the working-tree graph's view of what a
 * walked file holds. It is the only reader of that contract, so the file read
 * lives here, next to `tree-graph-walk.ts`, and the hash itself stays pure.
 */
import { promises as fs, readFileSync } from "node:fs";

import { fileContentHash } from "../../../../primitives/ids/index.js";

/** {@link fileContentHash} of the file at `absolutePath`; `undefined` when it cannot be read. */
export async function readFileContentHash(absolutePath: string): Promise<string | undefined> {
  try {
    return fileContentHash(await fs.readFile(absolutePath, "utf-8"));
  } catch {
    return undefined;
  }
}

/** {@link readFileContentHash}, synchronously — for a caller that must answer inside a synchronous lookup. */
export function readFileContentHashSync(absolutePath: string): string | undefined {
  try {
    return fileContentHash(readFileSync(absolutePath, "utf-8"));
  } catch {
    return undefined;
  }
}
