/**
 * Read a value from a nested object using dot-notation path.
 * Returns undefined if any segment is missing.
 * Handles both flat (Qdrant-stored) and nested payload shapes.
 */
export function readPayloadPath(payload: Record<string, unknown>, path: string): unknown {
  if (path in payload) return payload[path];
  const parts = path.split(".");
  let current: unknown = payload;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
