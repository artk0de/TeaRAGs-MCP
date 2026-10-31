/**
 * The class-level header of a container answer (progressive disclosure): a
 * container id answers its member outline AND its header chunks — the
 * class-level windows a class-body chunker or the engine's container remainder
 * emits under the container's own symbolId (constants, DSL statements,
 * includes, short defs, fields). Every header chunk is listed in line order
 * with a composition read off its `memberSymbolIds`; whole chunks are inlined,
 * in line order, while their summed text stays within
 * {@link CONTAINER_HEADER_CHAR_BUDGET} and within what the answer's shared
 * {@link BATCH_FULL_TEXT_CHAR_BUDGET} still holds; a chunk past either stays an
 * address — each member id it declares answers exactly that chunk.
 */
import type { SearchResult } from "../../../contracts/types/search-result.js";
import {
  BATCH_FULL_TEXT_CHAR_BUDGET,
  CONTAINER_HEADER_CHAR_BUDGET,
  CONTAINER_HEADER_DRAFT_KEY,
  CONTAINER_HEADER_KIND,
} from "../../../contracts/types/symbol-batch.js";
import type { ScrollChunk } from "./types.js";

export { CONTAINER_HEADER_DRAFT_KEY };

/** One header chunk as the answer lists and may inline it. */
interface HeaderChunkDraft {
  id: string | number;
  range: string;
  composition: string;
  text: string;
}

/** Everything a container row's content is rendered from, budget aside. */
export interface ContainerHeaderDraft {
  /** The container's own outline line. */
  ownerLine: string;
  /** Its direct-ancestor lines, already formatted (bd tea-rags-mcp-82cot). */
  ancestorLines: string[];
  /** Its member outline lines, already formatted. */
  memberLines: string[];
  /** Its header chunks, in line order. */
  chunks: HeaderChunkDraft[];
}

/** A container row's content under one allowance. */
export interface RenderedContainerHeader {
  content: string;
  /** Ids of the inlined chunks — the chunks whose text the content carries. */
  inlinedChunkIds: (string | number)[];
  /** Chars of header text inlined: what the row draws on the answer budget. */
  spent: number;
}

type NotInlinedReason = "class" | "answer";

const CONSTANT_NAME = /^[A-Z][A-Z0-9_]*$/;

/** The draft of `ownerId`'s answer from its outline lines and class-level chunks. */
export function draftContainerHeader(
  ownerId: string,
  ownerLine: string,
  ancestorLines: string[],
  memberLines: string[],
  rows: readonly ScrollChunk[],
): ContainerHeaderDraft {
  const sorted = [...rows].sort((a, b) => lineOf(a, "startLine") - lineOf(b, "startLine"));
  return {
    ownerLine,
    ancestorLines,
    memberLines,
    chunks: sorted.map((row) => ({
      id: row.id,
      range: `${lineOf(row, "startLine")}–${lineOf(row, "endLine")}`,
      composition: compositionOf(ownerId, row.payload.memberSymbolIds),
      text: typeof row.payload.content === "string" ? row.payload.content : "",
    })),
  };
}

/**
 * Render a container row: the owner line, one line per header chunk, the
 * member lines, a notice when a chunk stayed an address, then the inlined
 * chunks. Whole chunks are inlined in line order while the per-class budget
 * AND `allowance` (the answer budget still unspent) both admit them; a chunk is
 * never cut.
 */
export function renderContainerHeader(draft: ContainerHeaderDraft, allowance = Infinity): RenderedContainerHeader {
  const listing: string[] = [];
  const inlined: string[] = [];
  const inlinedChunkIds: (string | number)[] = [];
  const reasons = new Set<NotInlinedReason>();
  let spent = 0;
  let open = true;
  let unaddressed = false;
  let classLine: string | undefined;
  for (const chunk of draft.chunks) {
    const line = `  header ${chunk.range}${chunk.composition ? `: ${chunk.composition}` : ""}`;
    const text = withoutRepeatedClassLine(chunk.text, classLine);
    const withinClass = text.length > 0 && spent + text.length <= CONTAINER_HEADER_CHAR_BUDGET;
    const withinAnswer = spent + text.length <= allowance;
    open = open && withinClass && withinAnswer;
    if (open) {
      spent += text.length;
      classLine ??= firstLineOf(chunk.text);
      inlined.push(`── header ${chunk.range} ──\n${text}`);
      inlinedChunkIds.push(chunk.id);
      listing.push(line);
      continue;
    }
    const reason: NotInlinedReason = withinClass && !withinAnswer ? "answer" : "class";
    reasons.add(reason);
    listing.push(`${line} — not inlined${reason === "answer" ? " (answer budget)" : ""}`);
    if (!chunk.composition) unaddressed = true;
  }
  const notice = reasons.size === 0 ? undefined : noticeOf(reasons, unaddressed);
  const outline = [
    draft.ownerLine,
    ...draft.ancestorLines,
    ...listing,
    ...draft.memberLines,
    ...(notice ? [notice] : []),
  ];
  const content = [...outline, ...(inlined.length > 0 ? ["", ...inlined] : [])].join("\n");
  return { content, inlinedChunkIds, spent };
}

/**
 * Re-render a container row under `allowance` — the answer budget still
 * unspent where this row stands in the answer. Undefined for a row carrying no
 * draft (not a container row with header chunks). The payload keeps its draft
 * so a later, smaller allowance can re-render it again.
 */
export function spendContainerHeaderAllowance<R extends Pick<SearchResult, "payload">>(
  result: R,
  allowance: number,
): { result: R; spent: number } | undefined {
  const draft = result.payload?.[CONTAINER_HEADER_DRAFT_KEY] as ContainerHeaderDraft | undefined;
  if (!draft) return undefined;
  const rendered = renderContainerHeader(draft, allowance);
  const { kind: _kind, ...rest } = result.payload ?? {};
  const payload: Record<string, unknown> = {
    ...rest,
    content: rendered.content,
    mergedChunkIds: rendered.inlinedChunkIds,
    ...(rendered.inlinedChunkIds.length > 0 ? { kind: CONTAINER_HEADER_KIND } : {}),
  };
  return { result: { ...result, payload }, spent: rendered.spent };
}

function firstLineOf(text: string): string {
  return text.split("\n", 1)[0];
}

/**
 * A header chunk's text without the class-header line the first inlined chunk
 * already showed: every class-body chunk repeats its container's declaration
 * line, so a container answer inlining several of them prints it once (bd
 * tea-rags-mcp-9f0yn.3).
 */
function withoutRepeatedClassLine(text: string, classLine: string | undefined): string {
  if (classLine === undefined || !text.startsWith(`${classLine}\n`)) return text;
  return text.slice(classLine.length + 1);
}

function noticeOf(reasons: ReadonlySet<NotInlinedReason>, unaddressed: boolean): string {
  const limits = [
    ...(reasons.has("class") ? [`the ${CONTAINER_HEADER_CHAR_BUDGET}-char per-class header budget`] : []),
    ...(reasons.has("answer") ? [`the ${BATCH_FULL_TEXT_CHAR_BUDGET}-char answer budget for inlined text`] : []),
  ];
  const none = unaddressed ? "; one declaring none is addressed only by its lines" : "";
  return `(header chunks marked not inlined are past ${limits.join(" or ")}; each member id such a chunk declares answers that chunk${none})`;
}

/**
 * A chunk's composition, derived from its member ids alone: `2 const`,
 * `1 class`, each DSL macro (`enum :mode` once, `validates ×3` repeated), then
 * `N method id(s)`. Empty when the chunk declares no member.
 */
function compositionOf(ownerId: string, memberSymbolIds: unknown): string {
  if (!Array.isArray(memberSymbolIds)) return "";
  let constants = 0;
  let classes = 0;
  let methods = 0;
  const macros = new Map<string, { count: number; first: string }>();
  for (const id of memberSymbolIds) {
    if (typeof id !== "string") continue;
    const rest = id.startsWith(ownerId) ? id.slice(ownerId.length) : id;
    if (rest.startsWith("::")) {
      if (CONSTANT_NAME.test(rest.slice(2))) constants++;
      else classes++;
      continue;
    }
    const space = rest.indexOf(" ");
    if (rest.startsWith(".") && space > 0) {
      const macro = rest.slice(1, space);
      const entry = macros.get(macro);
      if (entry) entry.count++;
      else macros.set(macro, { count: 1, first: rest.slice(space + 1).replace(/~\d+$/, "") });
      continue;
    }
    methods++;
  }
  const parts: string[] = [];
  if (constants > 0) parts.push(`${constants} const`);
  if (classes > 0) parts.push(`${classes} class`);
  for (const [macro, { count, first }] of macros) parts.push(count === 1 ? `${macro} ${first}` : `${macro} ×${count}`);
  if (methods > 0) parts.push(`${methods} method id${methods === 1 ? "" : "s"}`);
  return parts.join(", ");
}

function lineOf(row: ScrollChunk, key: "startLine" | "endLine"): number {
  return Number(row.payload[key]) || 0;
}
