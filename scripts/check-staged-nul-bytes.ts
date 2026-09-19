/**
 * Fail a commit whose staged text files carry a raw NUL byte (bd
 * tea-rags-mcp-k8gac). Run by `.husky/pre-commit` on every commit, from the
 * repository root.
 *
 * `tests/source-nul-bytes.test.ts` scans the whole tracked tree, but the hook
 * selects tests with `vitest related <staged files>` — by imports — and that
 * guard imports nothing a commit stages, so it only ran when it was itself
 * staged. This check reads the staged blobs directly and does not depend on
 * that selection.
 */

import { describeNulByteOffense, findStagedNulBytes, NUL_BYTE_FIX_HINT } from "./lib/nul-bytes.js";

const offenses = findStagedNulBytes(process.cwd());
if (offenses.length > 0) {
  console.error(`Staged files carry ${offenses.length} raw NUL byte(s); ${NUL_BYTE_FIX_HINT}:`);
  for (const offense of offenses) console.error(`  ${describeNulByteOffense(offense)}`);
  process.exit(1);
}
