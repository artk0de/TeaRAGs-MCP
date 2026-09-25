import ignore from "ignore";

import { NON_PRODUCTION_PATTERNS } from "./patterns.js";
import type { PathFilter } from "./test-path-filter.js";

/**
 * Matches a repo-relative path against {@link NON_PRODUCTION_PATTERNS} — the
 * development tooling that is source code but not the product
 * (bd tea-rags-mcp-r8hme.9). Case-insensitive, like the test shapes.
 */
export function buildNonProductionPathFilter(): PathFilter {
  const matcher = ignore().add(NON_PRODUCTION_PATTERNS);
  return { ignores: (relPath) => matcher.ignores(relPath) };
}
