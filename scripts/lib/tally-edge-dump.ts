/**
 * The `--dump-edges` artifact of `codegraph-chain-tally.ts`: every call site's
 * resolver answer as one TSV line, followed by the per-receiver-kind run stats
 * verbatim. Two dumps of one corpus diff to empty exactly when the resolver's
 * edges and counters are unchanged — the identity gate a behaviour-preserving
 * lift is held to.
 *
 * Rows are sorted (relPath, line, callText, then the whole line), so the dump
 * does not depend on walk order and needs no external `sort` to diff.
 */
export interface TallyEdgeDumpRow {
  relPath: string;
  line: number;
  callText: string;
  receiverKind: string;
  targetRelPath: string | null;
  targetSymbolId: string | null;
  edgeKind: string;
}

/** The TSV cell for a missing target. */
const ABSENT_CELL = "-";

function renderRow(row: TallyEdgeDumpRow): string {
  // A multi-line call would break one row across lines and a tab would add a
  // column; either one makes the TSV undiffable line-for-line.
  const callText = row.callText.replace(/[\t\r\n]/g, " ");
  return [
    row.relPath,
    String(row.line),
    callText,
    row.receiverKind,
    row.targetRelPath ?? ABSENT_CELL,
    row.targetSymbolId ?? ABSENT_CELL,
    row.edgeKind,
  ].join("\t");
}

function compareRows(a: { row: TallyEdgeDumpRow; text: string }, b: { row: TallyEdgeDumpRow; text: string }): number {
  if (a.row.relPath !== b.row.relPath) return a.row.relPath < b.row.relPath ? -1 : 1;
  if (a.row.line !== b.row.line) return a.row.line - b.row.line;
  if (a.row.callText !== b.row.callText) return a.row.callText < b.row.callText ? -1 : 1;
  if (a.text === b.text) return 0;
  return a.text < b.text ? -1 : 1;
}

export function formatTallyEdgeDump(rows: readonly TallyEdgeDumpRow[], kindStats: string): string {
  const lines = rows
    .map((row) => ({ row, text: renderRow(row) }))
    .sort(compareRows)
    .map((entry) => entry.text);
  return `${[...lines, "#kind-stats", kindStats].join("\n")}\n`;
}
