import { resolvePayloadValue } from "../../../../contracts/signal-utils.js";

/**
 * Read a value from a payload using a dot-notation path.
 * Thin delegate of the canonical resolvePayloadValue
 * (contracts/signal-utils.ts) — the single source of truth for payload
 * addressing.
 */
export function readPayloadPath(
  payload: Record<string, unknown>,
  path: string,
): unknown {
  return resolvePayloadValue(payload, path);
}
