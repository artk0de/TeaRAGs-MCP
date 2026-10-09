import { RELATIVE_PATH_EXACT_KEY } from "../../../contracts/relative-path-exact.js";

/**
 * Payload keys that exist for the index, not for the reader. `relativePathExact`
 * repeats `relativePath` byte for byte; it is there so path-membership filters
 * get a keyword index (bd tea-rags-mcp-ejio7).
 */
const INTERNAL_PAYLOAD_FIELDS = [RELATIVE_PATH_EXACT_KEY] as const;

/** Remove internal payload fields that should not appear in MCP responses. */
export function stripInternalFields(payload: Record<string, unknown>): Record<string, unknown> {
  const result = { ...payload };
  for (const field of INTERNAL_PAYLOAD_FIELDS) {
    delete result[field];
  }
  return result;
}
