/**
 * The class-level header of a container answer (progressive disclosure): a
 * container id answers its member outline AND its header chunks — the
 * class-level windows a class-body chunker or the engine's container remainder
 * emits under the container's own symbolId (constants, DSL statements,
 * includes, short defs, fields). Every header chunk is listed in line order
 * with a composition read off its `memberSymbolIds`; whole chunks are inlined,
 * in line order, while their summed text stays within
 * {@link CONTAINER_HEADER_CHAR_BUDGET}; a chunk past it stays an address — each
 * member id it declares answers exactly that chunk.
 */
import { CONTAINER_HEADER_CHAR_BUDGET } from "../../../contracts/types/symbol-batch.js";
import type { ScrollChunk } from "./types.js";

/** What a container answer adds for its header chunks. */
export interface ContainerHeaderSection {
  /** One line per header chunk, in line order, indented as outline members. */
  listing: string[];
  /** The notice line when a chunk was not inlined, else undefined. */
  notice?: string;
  /** The inlined chunks, each under its `── header a–b ──` rule, in line order. */
  inlined: string[];
  /** Ids of the inlined chunks — the chunks whose text the answer carries. */
  inlinedChunkIds: (string | number)[];
}

const CONSTANT_NAME = /^[A-Z][A-Z0-9_]*$/;

/** Plan the header section of `ownerId`'s answer from its class-level chunks. */
export function renderContainerHeader(ownerId: string, headerChunks: readonly ScrollChunk[]): ContainerHeaderSection {
  const sorted = [...headerChunks].sort((a, b) => lineOf(a, "startLine") - lineOf(b, "startLine"));
  const listing: string[] = [];
  const inlined: string[] = [];
  const inlinedChunkIds: (string | number)[] = [];
  let spent = 0;
  let open = true;
  let unaddressed = false;
  for (const chunk of sorted) {
    const text = typeof chunk.payload.content === "string" ? chunk.payload.content : "";
    const range = `${lineOf(chunk, "startLine")}–${lineOf(chunk, "endLine")}`;
    open = open && text.length > 0 && spent + text.length <= CONTAINER_HEADER_CHAR_BUDGET;
    const composition = compositionOf(ownerId, chunk.payload.memberSymbolIds);
    const line = `  header ${range}${composition ? `: ${composition}` : ""}`;
    if (open) {
      spent += text.length;
      inlined.push(`── header ${range} ──\n${text}`);
      inlinedChunkIds.push(chunk.id);
      listing.push(line);
      continue;
    }
    listing.push(`${line} — not inlined`);
    if (!composition) unaddressed = true;
  }
  const notInlined = sorted.length - inlinedChunkIds.length;
  const notice =
    notInlined === 0
      ? undefined
      : `(header chunks marked not inlined are past the ${CONTAINER_HEADER_CHAR_BUDGET}-char per-class header budget; ` +
        `each member id such a chunk declares answers that chunk${unaddressed ? "; one declaring none is addressed only by its lines" : ""})`;
  return { listing, ...(notice ? { notice } : {}), inlined, inlinedChunkIds };
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
