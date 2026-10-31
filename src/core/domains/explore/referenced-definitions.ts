/**
 * Referenced definitions of a find_symbol method row (bd tea-rags-mcp-d0z7b.4):
 * the statements defining the class-level constants its body names. A method
 * body that reads `PREVIEWABLE_EXTENSIONS_REGEX` answers half a question — the
 * caller's next move is a grep for `NAME =`. The definitions are found through
 * the owner's header chunks (`memberSymbolIds`, the ids a class body chunker
 * declares), and their text is read from the tree file, never stitched from
 * chunks. Language-neutral: a member qualifies when its tail name occurs in the
 * body as a token, bare or qualified by the row's own owner, and a statement in
 * the header chunk's line range begins with that name.
 */
import type { SearchResult } from "../../contracts/types/search-result.js";
import { REFERENCED_DEFINITIONS_ROW_CHAR_CAP } from "../../contracts/types/symbol-batch.js";
import type { ScrollChunk } from "./chunk-grouping/index.js";

/** `payload` key of a method row's referenced definitions. */
export const REFERENCED_DEFINITIONS_KEY = "referencedDefinitions";

/** One referenced definition; `text` is absent when a cap left it out. */
export interface ReferencedDefinition {
  symbolId: string;
  startLine: number;
  endLine: number;
  text?: string;
}

export interface ReferencedDefinitionsInput {
  /** The method row's content. */
  body: string;
  /** The row's owner — its `parentSymbolId`. */
  ownerSymbolId: string;
  /** Header chunks of the row's file; only the owner's own count. */
  headerChunks: readonly ScrollChunk[];
  /** The tree file's text the definitions are read from. */
  treeText: string;
}

/** Longest statement span followed, in lines — a runaway bracket never reads a whole file. */
const MAX_STATEMENT_LINES = 60;

/**
 * Definitions the body references, in first-reference order; their summed text
 * stays within {@link REFERENCED_DEFINITIONS_ROW_CHAR_CAP}, a definition past it
 * keeps only its id and lines.
 */
export function collectReferencedDefinitions(input: ReferencedDefinitionsInput): ReferencedDefinition[] {
  const { body, ownerSymbolId, headerChunks, treeText } = input;
  const treeLines = treeText.split("\n");
  const found: { at: number; definition: ReferencedDefinition }[] = [];
  const seen = new Set<string>();
  for (const chunk of headerChunks) {
    if (!isOwnHeaderChunk(chunk, ownerSymbolId)) continue;
    const startLine = Number(chunk.payload.startLine) || 0;
    const endLine = Math.min(Number(chunk.payload.endLine) || 0, treeLines.length);
    for (const memberId of chunk.payload.memberSymbolIds as unknown[]) {
      if (typeof memberId !== "string" || seen.has(memberId) || !memberId.startsWith(ownerSymbolId)) continue;
      const name = memberId.slice(ownerSymbolId.length).replace(/^\W+/, "");
      if (!/^\w+$/.test(name)) continue;
      const at = firstReference(body, name, ownerSymbolId);
      if (at < 0) continue;
      const span = statementSpan(treeLines, name, startLine, endLine);
      if (!span) continue;
      seen.add(memberId);
      const text = treeLines.slice(span.startLine - 1, span.endLine).join("\n");
      found.push({ at, definition: { symbolId: memberId, ...span, text } });
    }
  }
  found.sort((a, b) => a.at - b.at);
  let room = REFERENCED_DEFINITIONS_ROW_CHAR_CAP;
  return found.map(({ definition }) => {
    const size = definition.text?.length ?? 0;
    if (size <= room) {
      room -= size;
      return definition;
    }
    return withoutText(definition);
  });
}

/**
 * Re-render a row's referenced definitions under an answer `allowance`: text
 * kept in order while it fits, the rest named by id and lines. Undefined when
 * the row carries none.
 */
export function spendReferencedDefinitionsAllowance<R extends Pick<SearchResult, "payload">>(
  result: R,
  allowance: number,
): { result: R; spent: number } | undefined {
  const definitions = result.payload?.[REFERENCED_DEFINITIONS_KEY] as ReferencedDefinition[] | undefined;
  if (!Array.isArray(definitions) || definitions.length === 0) return undefined;
  let spent = 0;
  const rendered = definitions.map((definition) => {
    const size = definition.text?.length ?? 0;
    if (size === 0) return definition;
    if (spent + size <= allowance) {
      spent += size;
      return definition;
    }
    return withoutText(definition);
  });
  return { result: { ...result, payload: { ...result.payload, [REFERENCED_DEFINITIONS_KEY]: rendered } }, spent };
}

function isOwnHeaderChunk(chunk: ScrollChunk, ownerSymbolId: string): boolean {
  const { symbolId, parentSymbolId, memberSymbolIds } = chunk.payload;
  return symbolId === ownerSymbolId && parentSymbolId === ownerSymbolId && Array.isArray(memberSymbolIds);
}

/**
 * Offset of the first occurrence of `name` as a token in `body` that is bare or
 * qualified by the owner (`Owner::NAME`, a tail of the owner id), else -1.
 */
function firstReference(body: string, name: string, ownerSymbolId: string): number {
  const token = new RegExp(`(?<![\\w])${name}(?![\\w])`, "g");
  for (const match of body.matchAll(token)) {
    const qualifier = /([\w:.]*?)(::|\.)$/.exec(body.slice(0, match.index));
    if (!qualifier) return match.index;
    const owner = qualifier[1];
    if (owner === ownerSymbolId || ownerSymbolId.endsWith(`::${owner}`) || ownerSymbolId.endsWith(`.${owner}`)) {
      return match.index;
    }
  }
  return -1;
}

/**
 * Lines of the statement within `[startLine, endLine]` that begins with `name`
 * followed by an assignment or a declaration colon, followed through open
 * brackets and trailing continuation characters.
 */
function statementSpan(
  treeLines: readonly string[],
  name: string,
  startLine: number,
  endLine: number,
): { startLine: number; endLine: number } | undefined {
  const head = new RegExp(`^\\s*${name}\\s*(?:\\|\\|=|=(?![=~])|:(?!:))`);
  for (let line = Math.max(1, startLine); line <= endLine; line++) {
    if (!head.test(treeLines[line - 1] ?? "")) continue;
    let depth = 0;
    let last = line;
    for (; last <= Math.min(endLine, line + MAX_STATEMENT_LINES - 1); last++) {
      const text = treeLines[last - 1] ?? "";
      depth += bracketBalance(text);
      const next = treeLines[last] ?? "";
      const continues = depth > 0 || /[,\\+|&(=[{]\s*$/.test(text) || /^\s*(?:\.|&\.)/.test(next);
      if (!continues || last === endLine) break;
    }
    return { startLine: line, endLine: Math.min(last, endLine) };
  }
  return undefined;
}

function bracketBalance(text: string): number {
  let balance = 0;
  for (const ch of text) {
    if (ch === "(" || ch === "[" || ch === "{") balance++;
    else if (ch === ")" || ch === "]" || ch === "}") balance--;
  }
  return balance;
}

function withoutText(definition: ReferencedDefinition): ReferencedDefinition {
  const { text: _text, ...located } = definition;
  return located;
}
