/**
 * Packed test chunks, read back one member at a time.
 *
 * The test-scope chunker PACKS several members into one chunk: the setup of
 * consecutive scopes (bd tea-rags-mcp-5xpq4) and the adjacent examples of one
 * scope (bd tea-rags-mcp-g5i0a). Either pack stores its members' rows back to
 * back after a shared header, with `memberRowCounts` saying how many rows each
 * member takes. Hydration renders one setup member out of its pack; find_symbol
 * answers one example's id with that example out of its pack. Both slice by the
 * same arithmetic, owned here.
 */

import { TEST_SCOPE_PARENT_TYPE } from "../../contracts/types/chunker.js";

interface LineRange {
  start: number;
  end: number;
}

/**
 * A pack's windows → the container header and each member's rows.
 *
 * The kernel stores the members' own rows back to back; the engine prepends
 * the container header (zero or more rows), and when it cuts a pack into
 * `#partN` windows it repeats that header on every window — or, when the
 * header is too large to repeat, puts it on the first window only. Both
 * layouts are recognised from the row arithmetic: the rows that are not
 * members' rows are the header, and they must be identical where they repeat.
 * A pack that fits neither (a row the engine character-sliced) returns
 * nothing rather than a slice that might render a sibling's rows.
 */
export function slicePack(
  windows: string[],
  rowCounts: number[],
): { header: string[]; members: string[][] } | undefined {
  const rowsOf = windows.map((w) => w.split("\n"));
  const memberRows = rowCounts.reduce((sum, n) => sum + n, 0);
  const totalRows = rowsOf.reduce((sum, rows) => sum + rows.length, 0);
  const extra = totalRows - memberRows;
  if (extra < 0) return undefined;

  let header: string[] | undefined;
  let body: string[] = [];
  if (extra % rowsOf.length === 0) {
    const perWindow = extra / rowsOf.length;
    const first = rowsOf[0].slice(0, perWindow);
    if (rowsOf.every((rows) => rows.length > perWindow && first.every((row, i) => rows[i] === row))) {
      header = first;
      body = rowsOf.flatMap((rows) => rows.slice(perWindow));
    }
  }
  if (header === undefined && rowsOf[0].length > extra) {
    header = rowsOf[0].slice(0, extra);
    body = [...rowsOf[0].slice(extra), ...rowsOf.slice(1).flat()];
  }
  if (header === undefined) return undefined;

  const members: string[][] = [];
  let offset = 0;
  for (const count of rowCounts) {
    members.push(body.slice(offset, offset + count));
    offset += count;
  }
  return { header, members };
}

/**
 * The payload of ONE example of an example pack (bd tea-rags-mcp-g5i0a): the
 * pack's header rows (container header, scope title path) and that member's
 * own rows, its id, name and own line range — the chunk the example would have
 * been had it not been packed. The pack fields are dropped. Undefined when the
 * payload is not an example pack carrying `memberId`, or when its per-member
 * arrays are missing (an index chunked before packs carried them) or do not
 * add up: the caller keeps the whole pack rather than a slice that might show
 * a sibling.
 */
export function examplePackMember(
  payload: Record<string, unknown>,
  memberId: string,
): Record<string, unknown> | undefined {
  if (payload.parentType !== TEST_SCOPE_PARENT_TYPE) return undefined;
  const { memberSymbolIds, memberRowCounts, memberLineRanges, content } = payload;
  if (!Array.isArray(memberSymbolIds)) return undefined;
  const index = memberSymbolIds.indexOf(memberId);
  if (index < 0) return undefined;
  if (!Array.isArray(memberRowCounts) || memberRowCounts.length !== memberSymbolIds.length) return undefined;
  if (!memberRowCounts.every((n) => Number.isInteger(n) && (n as number) > 0)) return undefined;
  if (!Array.isArray(memberLineRanges) || memberLineRanges.length !== memberSymbolIds.length) return undefined;
  const range = memberLineRanges[index] as unknown;
  if (!isLineRange(range)) return undefined;

  const member: Record<string, unknown> = {
    ...payload,
    symbolId: memberId,
    name: memberName(memberId, payload.parentSymbolId),
    startLine: range.start,
    endLine: range.end,
  };
  delete member.memberSymbolIds;
  delete member.memberRowCounts;
  delete member.memberLineRanges;
  if (typeof content === "string") {
    const sliced = slicePack([content], memberRowCounts as number[]);
    if (!sliced) return undefined;
    member.content = [...sliced.header, ...sliced.members[index]].join("\n");
  }
  return member;
}

/**
 * The example's own name: its id less the scope id and the `~N` a repeated
 * description carries — the kernel names an example `${scopeId}.${name}`.
 */
function memberName(memberId: string, scopeId: unknown): string {
  const own =
    typeof scopeId === "string" && memberId.startsWith(`${scopeId}.`) ? memberId.slice(scopeId.length + 1) : memberId;
  return own.replace(/~\d+$/, "");
}

export function isLineRange(value: unknown): value is LineRange {
  if (!value || typeof value !== "object") return false;
  const { start, end } = value as Record<string, unknown>;
  return typeof start === "number" && typeof end === "number";
}
