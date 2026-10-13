/**
 * Sink-time row builder for `cg_symbols_edges_field` (bd tea-rags-mcp-zy6hx,
 * D0): a file's `fieldAccesses` facts as the per-method field-access edges.
 *
 * Pure — one `FileExtraction` in, rows out, every language. Facts sharing
 * (method, owner kind, owner type, receiver, field, access kind) fold into one
 * row carrying how many sites they are and the first line of them. A file with
 * no facts — none accessed, or a language whose passes do not collect them —
 * yields `[]`, which is what clears its stored rows: an extraction pass that
 * finds nothing publishes no channel (`mergeExtraction` drops an empty one), so
 * "absent" has to clear, or a file that lost its last access would keep it.
 *
 * Rows come out in a fixed order (method, first line, field, access kind, then
 * the owner columns), so the same facts always yield the same row list.
 */

import type { FieldAccessFact, FieldAccessRow, FileExtraction } from "../../../../contracts/types/codegraph.js";

/** The identity a fact aggregates under — every row column but the count and the line. */
function fieldAccessRowKey(fact: FieldAccessFact): string {
  return JSON.stringify([
    fact.symbolId,
    fact.ownerKind,
    fact.ownerType ?? null,
    fact.receiver ?? null,
    fact.fieldName,
    fact.accessKind,
  ]);
}

function compareText(a: string | undefined, b: string | undefined): number {
  const left = a ?? "";
  const right = b ?? "";
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareFieldAccessRows(a: FieldAccessRow, b: FieldAccessRow): number {
  return (
    compareText(a.sourceSymbolId, b.sourceSymbolId) ||
    a.firstLine - b.firstLine ||
    compareText(a.fieldName, b.fieldName) ||
    compareText(a.accessKind, b.accessKind) ||
    compareText(a.ownerKind, b.ownerKind) ||
    compareText(a.ownerType, b.ownerType) ||
    compareText(a.receiver, b.receiver)
  );
}

export function buildFieldAccessRows(extraction: FileExtraction): FieldAccessRow[] {
  const rowsByKey = new Map<string, FieldAccessRow>();
  for (const fact of extraction.fieldAccesses ?? []) {
    const key = fieldAccessRowKey(fact);
    const row = rowsByKey.get(key);
    if (row !== undefined) {
      row.accessCount += 1;
      row.firstLine = Math.min(row.firstLine, fact.line);
      continue;
    }
    rowsByKey.set(key, {
      sourceSymbolId: fact.symbolId,
      ownerKind: fact.ownerKind,
      ...(fact.ownerType === undefined ? {} : { ownerType: fact.ownerType }),
      ...(fact.receiver === undefined ? {} : { receiver: fact.receiver }),
      fieldName: fact.fieldName,
      accessKind: fact.accessKind,
      accessCount: 1,
      firstLine: fact.line,
    });
  }
  return [...rowsByKey.values()].sort(compareFieldAccessRows);
}
