/**
 * find_symbol row compaction — the presentation step a find_symbol answer
 * passes through before it is tabulated (bd tea-rags-mcp-d0z7b.2).
 *
 * An exact lookup row named its address up to three times — the point `id`,
 * `payload.request` (symbols batch) and `payload.symbolId` / `relativePath` —
 * and carried `score: 1` on every row. Each row keeps one locator:
 *
 *   - `id` goes when `payload.symbolId` is a non-empty string (the row is
 *     addressed by it; find_similar positiveIds take it too). A row with no
 *     symbolId keeps `id`.
 *   - `score` goes when it is 1 — the lookup's constant, it ranks nothing.
 *   - `payload.request` goes when it equals `payload.symbolId`, or equals
 *     `payload.relativePath` on a row with no symbolId. A row without `request`
 *     is therefore addressed by `symbolId ?? relativePath` ({@link batchAddressOf}),
 *     which is also what a `sameChunkAs` naming that row resolves to.
 *
 * Runs on the projected rows, so a `fields` projection that dropped symbolId
 * keeps both `id` and `request`.
 */

import type { SearchResult } from "../public/dto/explore.js";

const LOOKUP_SCORE = 1;

/** Each find_symbol row without the locators another of its fields already carries. */
export function withoutRedundantLocators(results: readonly SearchResult[]): object[] {
  return results.map(({ id, score, payload, ...row }) => {
    const symbolId = nonEmptyString(payload?.symbolId);
    return {
      ...(symbolId === undefined ? { id } : {}),
      ...(score === LOOKUP_SCORE ? {} : { score }),
      ...(payload ? { payload: withoutRedundantRequest(payload, symbolId) } : {}),
      ...row,
    };
  });
}

/** The address a symbols-batch row answers: `request`, else the locator that made it redundant. */
export function batchAddressOf(request: unknown, symbolId: unknown, relativePath: unknown): unknown {
  return request ?? symbolId ?? relativePath;
}

function withoutRedundantRequest(
  payload: Record<string, unknown>,
  symbolId: string | undefined,
): Record<string, unknown> {
  const { request, ...rest } = payload;
  if (request === undefined) return payload;
  const redundant = symbolId === undefined ? request === payload.relativePath : request === symbolId;
  return redundant ? rest : payload;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
