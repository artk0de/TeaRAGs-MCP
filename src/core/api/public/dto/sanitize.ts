import { RELATIVE_PATH_EXACT_KEY } from "../../../contracts/relative-path-exact.js";
import { CONTAINER_HEADER_DRAFT_KEY } from "../../../contracts/types/symbol-batch.js";

/**
 * Payload keys that exist for the index or the read path, not for the reader.
 * `relativePathExact` repeats `relativePath` byte for byte; it is there so
 * path-membership filters get a keyword index (bd tea-rags-mcp-ejio7). The
 * container header draft is what the answer's shared inlined-text budget
 * re-renders a class row from; its text is already in `content`.
 */
const INTERNAL_PAYLOAD_FIELDS = [RELATIVE_PATH_EXACT_KEY, CONTAINER_HEADER_DRAFT_KEY] as const;

/** Remove internal payload fields that should not appear in MCP responses. */
export function stripInternalFields(payload: Record<string, unknown>): Record<string, unknown> {
  const result = { ...payload };
  for (const field of INTERNAL_PAYLOAD_FIELDS) {
    delete result[field];
  }
  return result;
}
