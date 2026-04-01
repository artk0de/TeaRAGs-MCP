const INTERNAL_PAYLOAD_FIELDS = ["headingPath"] as const;

/** Remove internal payload fields that should not appear in MCP responses. */
export function stripInternalFields(payload: Record<string, unknown>): Record<string, unknown> {
  const result = { ...payload };
  for (const field of INTERNAL_PAYLOAD_FIELDS) {
    delete result[field];
  }
  return result;
}
