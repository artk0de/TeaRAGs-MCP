/**
 * SymbolBatchDrill — several find_symbol addresses in one call (agent turn
 * economy N1).
 *
 * Each address resolves through its own SymbolSearchStrategy — the exact path
 * a single `symbol:` takes: text-match scroll, working-tree substitution,
 * `#partN` merge, codegraph fallback. Every strategy runs on the SAME context,
 * so they share one working-tree view: the floors they claim accumulate on one
 * marker, which the caller finalizes once for the whole answer. The drill adds
 * only what a batch needs on top: the request per row, the `#`↔`.` retry
 * reported as `resolvedAs`, an ambiguity cap, and the misses.
 */

import type { EmptyAnswerExplanation } from "../../contracts/types/empty-answer.js";
import {
  BATCH_FULL_TEXT_CHAR_BUDGET,
  FULL_TEXT_MAX_LINES,
  type SymbolBatchMiss,
} from "../../contracts/types/symbol-batch.js";
import { Semaphore } from "../../primitives/concurrency/index.js";
import { lastNameSegment } from "../../primitives/ids/index.js";
import { spendContainerHeaderAllowance } from "./chunk-grouping/index.js";
import { containerMemberMessage, findContainerMembers, rankByNamespaceProximity } from "./member-miss.js";
import type { FileOutlineStrategy } from "./strategies/file-outline.js";
import type { SymbolSearchStrategy } from "./strategies/symbol.js";
import type { ExploreContext, ExploreResult } from "./strategies/types.js";
import { relativePathOf } from "./working-tree/index.js";

/** The next step an unknown address calls for — shared by a batch miss and a single-symbol `empty`. */
export const UNKNOWN_SYMBOL_HINT = "retry a partial address (Class or bare name), or hybrid_search";

/** The next step an unknown path entry calls for. */
const UNKNOWN_PATH_HINT = "retry a suggested path, or find_symbol(relativePath: <dir>)";

/**
 * Said once per batch answer in which a path entry was outlined instead of
 * read, or a directory refused: which paths, and why. It names the call
 * shape, never a member id — an agent reads exactly the example a notice
 * names, not what it needs.
 */
function batchPathNotice(overLines: readonly string[], overBudget: readonly string[], directory: boolean): string {
  const parts: string[] = [];
  if (overLines.length > 0) {
    parts.push(`over ${FULL_TEXT_MAX_LINES} lines, outlined: ${overLines.join(", ")} — read bodies by the member ids`);
  }
  if (overBudget.length > 0) {
    parts.push(
      `past the batch's ${BATCH_FULL_TEXT_CHAR_BUDGET}-char full-text budget, outlined: ${overBudget.join(", ")} — ` +
        `choose only the member ids needed for the task from the outlines, then ONE find_symbol(symbols:[<needed ids>]) batch; ` +
        `only if whole small files are explicitly needed, continue with find_symbol(symbols:${JSON.stringify(overBudget)})`,
    );
  }
  if (directory) parts.push("a directory → missing");
  return parts.join("; ");
}

/**
 * Extensions a bare root-level name (`README.md`, `package.json`) is read as a
 * file by. Path-shaped only — a miss still falls back to the symbol strategy,
 * so a `Foo.rb`-style id is answered either way.
 */
const BARE_FILE_EXTENSIONS = new Set([
  "md",
  "mdx",
  "txt",
  "json",
  "yml",
  "yaml",
  "toml",
  "ini",
  "cfg",
  "xml",
  "html",
  "css",
  "lock",
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "swift",
  "php",
  "cs",
  "sh",
]);

/** Matches one address may answer with; more is a miss asking to qualify it. */
const MAX_MATCHES_PER_ADDRESS = 5;

/** Candidates an ambiguous miss names (bd tea-rags-mcp-d9w4o). */
const MAX_AMBIGUOUS_CANDIDATES = 7;

/**
 * Which candidates an ambiguous miss lists first: a class / module outline is
 * what a bare type name most often addresses, a type alias or interface
 * declaration least often.
 */
const AMBIGUOUS_CHUNK_TYPE_RANK: Readonly<Record<string, number>> = { class: 0, function: 1, test: 1, block: 2 };
const AMBIGUOUS_UNRANKED_CHUNK_TYPE = 3;

/** Addresses resolved at once — each one runs two Qdrant scrolls. */
const ADDRESS_CONCURRENCY = 4;

export interface SymbolBatchRow {
  /** The address as the caller wrote it. */
  request: string;
  /** The id that answered, when it differs from `request` only by the `#`/`.` separator. */
  resolvedAs?: string;
  /** The row answers a file-path address: its `content` is the file outline (or text), not a symbol body. */
  fileOutline?: boolean;
  /**
   * The request of the row whose content already carries this row's chunk —
   * a header chunk several constant ids share, or one a class row inlined; this
   * row then keeps its locator and drops the repeated body.
   */
  sameChunkAs?: string;
  result: ExploreResult;
}

export interface SymbolBatchAnswer {
  rows: SymbolBatchRow[];
  missing: SymbolBatchMiss[];
  /** The first codegraph skip notice any address's strategy recorded. */
  codegraphWarning?: string;
  /** Present only when a path entry was outlined where `relativePath:` reads it, or a directory entry refused. */
  batchNotice?: string;
}

export class SymbolBatchDrill {
  /**
   * `outlineFor` answers a path entry (q1g6s.4) under the `relativePath:`
   * full-text rule; the batch then caps the summed full text at
   * {@link BATCH_FULL_TEXT_CHAR_BUDGET} (yz10n). Without it every entry is a
   * symbol address.
   */
  constructor(
    private readonly strategyFor: (symbol: string) => SymbolSearchStrategy,
    private readonly outlineFor?: (relativePath: string) => FileOutlineStrategy,
  ) {}

  async execute(addresses: readonly string[], ctx: ExploreContext): Promise<SymbolBatchAnswer> {
    const slots = new Semaphore(ADDRESS_CONCURRENCY);
    const resolved = await Promise.all(
      addresses.map(async (address) => {
        const release = await slots.acquire();
        try {
          return await this.resolve(address, ctx);
        } finally {
          release();
        }
      }),
    );
    const { answers, overBudget } = withinFullTextBudget(resolved);
    const overLines = answers.flatMap((a) => (a.pathNote === "overLines" ? [a.rows[0]?.request ?? ""] : []));
    const directory = answers.some((a) => a.pathNote === "directory");
    const downgraded = overLines.length > 0 || overBudget.length > 0 || directory;
    return {
      rows: dedupeChunkBodies(answers.flatMap((a) => a.rows)),
      missing: answers.flatMap((a) => (a.miss ? [a.miss] : [])),
      ...firstWarning(answers),
      ...(downgraded ? { batchNotice: batchPathNotice(overLines, overBudget, directory) } : {}),
    };
  }

  private async resolve(address: string, ctx: ExploreContext): Promise<AddressAnswer> {
    if (this.outlineFor && isFilePathAddress(address)) {
      const outline = this.outlineFor(address);
      const results = await outline.execute(ctx);
      // A directory listing is a whole-tree read: refused here, answered by `relativePath:` alone.
      if (outline.directory) return { rows: [], miss: directoryEntryMiss(address), pathNote: "directory" };
      if (results.length > 0) {
        const behind = outline.outlineBehindFullText;
        return {
          rows: results.map((result) => ({ request: address, fileOutline: true, result })),
          ...(outline.fullTextWithheld ? { pathNote: "overLines" as const } : {}),
          ...(behind ? { outlineBehindFullText: behind } : {}),
        };
      }
      // A file with no symbol chunk is no symbol either: its reason is the miss.
      const empty = outline.emptyAnswer;
      if (empty?.reason === "noSymbols") return { rows: [], miss: { request: address, message: empty.message } };
      // A bare root-level name that is no file may still be a symbol id; a slashed one, or one the tree has, is a path.
      if (address.includes("/") || empty?.reason === "ignoredPath") {
        return { rows: [], miss: unknownPathMiss(address, empty) };
      }
    }
    return this.resolveSymbol(address, ctx);
  }

  private async resolveSymbol(address: string, ctx: ExploreContext): Promise<AddressAnswer> {
    const first = await this.run(address, ctx);
    const swapped = first.results.length === 0 ? swapSeparator(address) : undefined;
    const answer = swapped === undefined ? first : await this.run(swapped, ctx);
    const warning = first.warning ?? answer.warning;
    const { results } = answer;
    if (results.length > MAX_MATCHES_PER_ADDRESS) {
      return {
        rows: [],
        miss: {
          request: address,
          message: `ambiguous: ${results.length} matches — qualify with Class# or pathPattern`,
          suggestions: ambiguousCandidates(results),
        },
        warning,
      };
    }
    if (results.length === 0) return { rows: [], miss: await this.missOf(address, ctx), warning };
    return {
      rows: results.map((result) => {
        const resolvedAs = resolvedAsOf(address, result);
        return { request: address, ...(resolvedAs ? { resolvedAs } : {}), result };
      }),
      warning,
    };
  }

  private async run(symbol: string, ctx: ExploreContext): Promise<{ results: ExploreResult[]; warning?: string }> {
    const strategy = this.strategyFor(symbol);
    const results = await strategy.execute(ctx);
    return { results, warning: strategy.codegraphWarning };
  }

  /**
   * Why nothing answered `address`. When the tree deleted files, the index is
   * asked without the overlay — never to answer, only to say whether the
   * address lived in a file the tree deleted.
   */
  private async missOf(address: string, ctx: ExploreContext): Promise<SymbolBatchMiss> {
    const deleted = ctx.workingTreeView?.deletedPaths;
    if (deleted && deleted.size > 0) {
      const { workingTreeView: _view, ...indexCtx } = ctx;
      const indexed = await this.strategyFor(address).execute({ ...indexCtx, metaOnly: true });
      if (indexed.some((row) => deleted.has(relativePathOf(row.payload)))) {
        return { request: address, message: "deleted in the working tree", treeState: "deleted" };
      }
    }
    const container = await findContainerMembers(address, this.strategyFor, ctx);
    if (container) {
      return { request: address, message: containerMemberMessage(container), suggestions: container.memberIds };
    }
    const suggestions = await this.sameTailIds(address, ctx);
    return {
      request: address,
      message: `unknown symbol — ${UNKNOWN_SYMBOL_HINT}`,
      ...(suggestions.length > 0 ? { suggestions } : {}),
    };
  }

  /**
   * A qualified miss never takes another owner's same-named symbol as its
   * answer (q1g6s.15) — those ids are offered instead, for the caller to pick,
   * closest namespace first (m9wrp).
   */
  private async sameTailIds(address: string, ctx: ExploreContext): Promise<string[]> {
    const tail = lastNameSegment(address);
    if (tail === address || tail.length === 0) return [];
    const rows = await this.strategyFor(tail).execute({ ...ctx, metaOnly: true });
    const namesakes = rows.flatMap((row) => {
      const symbolId = row.payload?.symbolId;
      return typeof symbolId === "string" ? [{ symbolId, relativePath: relativePathOf(row.payload) }] : [];
    });
    return rankByNamespaceProximity(address, namesakes).slice(0, MAX_MATCHES_PER_ADDRESS);
  }
}

interface AddressAnswer {
  rows: SymbolBatchRow[];
  miss?: SymbolBatchMiss;
  warning?: string;
  /** A path entry answered with an outline for its size (`overLines`), or a directory entry refused. */
  pathNote?: "overLines" | "directory";
  /** A path entry answered with full text: the outline it answers instead past the batch's budget. */
  outlineBehindFullText?: ExploreResult;
}

/**
 * Full text for the path entries in request order while their summed text
 * stays within {@link BATCH_FULL_TEXT_CHAR_BUDGET}; an entry past it answers
 * its outline instead — unless the outline is no shorter, which saves nothing —
 * and the entries after it are still measured. Returns the paths outlined.
 */
/**
 * One chunk body per batch: a row whose chunk another row's content already
 * carries — the same declaring chunk answering several constant ids, or a
 * header chunk a class row inlined (`mergedChunkIds`) — keeps its locator and
 * points at that row instead of repeating the body. The carrier is the row with
 * the longer content, the earlier one on a tie; file-path rows carry nothing.
 */
function dedupeChunkBodies(rows: SymbolBatchRow[]): SymbolBatchRow[] {
  const carried = (row: SymbolBatchRow): readonly unknown[] => {
    if (row.fileOutline) return [];
    const merged = row.result.payload?.mergedChunkIds;
    return Array.isArray(merged) ? merged : [row.result.id];
  };
  return rows.map((row, i) => {
    const body = row.result.payload?.content;
    if (row.fileOutline || typeof body !== "string" || body.length === 0) return row;
    const carrier = rows.find((other, j) => {
      if (j === i || !carried(other).includes(row.result.id)) return false;
      const text = other.result.payload?.content;
      if (typeof text !== "string" || !text.includes(body)) return false;
      return text.length > body.length || j < i;
    });
    if (!carrier) return row;
    const { content: _repeated, ...payload } = row.result.payload ?? {};
    return { ...row, sameChunkAs: carrier.request, result: { ...row.result, payload } };
  });
}

function withinFullTextBudget(answers: readonly AddressAnswer[]): { answers: AddressAnswer[]; overBudget: string[] } {
  let spent = 0;
  const overBudget: string[] = [];
  const budgeted = answers.map((answer) => {
    const outline = answer.outlineBehindFullText;
    const row = answer.rows[0];
    // Reserve requested file text before optional container headers, regardless
    // of where those headers occur in the request. File entries retain their
    // request-order priority when the files alone exceed the shared budget.
    if (!outline || !row) return answer;
    const size = contentLengthOf(row.result);
    if (spent + size <= BATCH_FULL_TEXT_CHAR_BUDGET || contentLengthOf(outline) >= size) {
      spent += size;
      return answer;
    }
    overBudget.push(row.request);
    return { ...answer, rows: [{ ...row, result: outline }] };
  });
  const withHeaders = budgeted.map((answer) => ({
    ...answer,
    rows: answer.rows.map((row) => {
      const rendered = spendContainerHeaderAllowance(row.result, Math.max(0, BATCH_FULL_TEXT_CHAR_BUDGET - spent));
      if (!rendered) return row;
      spent += rendered.spent;
      return { ...row, result: rendered.result };
    }),
  }));
  return { answers: withHeaders, overBudget };
}

function contentLengthOf(result: ExploreResult): number {
  const content = result.payload?.content;
  return typeof content === "string" ? content.length : 0;
}

function firstWarning(answers: readonly AddressAnswer[]): { codegraphWarning?: string } {
  const warning = answers.find((a) => a.warning !== undefined)?.warning;
  return warning === undefined ? {} : { codegraphWarning: warning };
}

/**
 * Whether a batch entry is shaped like a file path: slashed with no symbol
 * separator (`#`, `::`) and no whitespace, or a bare root-level name with a
 * known file extension. `Foo.bar`, `A::B#c`, `Integer#/` stay symbol ids.
 */
export function isFilePathAddress(address: string): boolean {
  if (/[\s#]|::/.test(address)) return false;
  if (address.includes("/")) return true;
  const extension = /^[\w.-]+\.([a-z0-9]+)$/.exec(address)?.[1];
  return extension !== undefined && BARE_FILE_EXTENSIONS.has(extension);
}

function directoryEntryMiss(address: string): SymbolBatchMiss {
  const dir = address.replace(/\/+$/, "");
  return { request: address, message: `directory — call find_symbol(relativePath: ${dir}) on its own` };
}

/** A path entry no file answered: an ignored tree path says so (bd tea-rags-mcp-d9w4o), else the nearest indexed paths. */
function unknownPathMiss(address: string, empty: EmptyAnswerExplanation | undefined): SymbolBatchMiss {
  if (empty?.reason === "ignoredPath") return { request: address, message: empty.message };
  const suggestions = empty?.suggestions;
  return {
    request: address,
    message: `unknown path — ${UNKNOWN_PATH_HINT}`,
    ...(suggestions && suggestions.length > 0 ? { suggestions: [...suggestions] } : {}),
  };
}

/**
 * An ambiguous address's candidates as `<symbolId> (<relativePath>)`, distinct,
 * class / module chunks first and type aliases last (stable within a rank),
 * at most {@link MAX_AMBIGUOUS_CANDIDATES}.
 */
function ambiguousCandidates(results: readonly ExploreResult[]): string[] {
  const ranked = results.flatMap((result) => {
    const symbolId = result.payload?.symbolId;
    if (typeof symbolId !== "string") return [];
    const chunkType = result.payload?.chunkType;
    const rank =
      (typeof chunkType === "string" ? AMBIGUOUS_CHUNK_TYPE_RANK[chunkType] : undefined) ??
      AMBIGUOUS_UNRANKED_CHUNK_TYPE;
    return [{ candidate: `${symbolId} (${relativePathOf(result.payload)})`, rank }];
  });
  const ordered = ranked.sort((a, b) => a.rank - b.rank).map(({ candidate }) => candidate);
  return [...new Set(ordered)].slice(0, MAX_AMBIGUOUS_CANDIDATES);
}

/** `Foo.bar` ↔ `Foo#bar` on the last separator; undefined for a bare name or a `::` tail. */
export function swapSeparator(address: string): string | undefined {
  const match = /^(.+)([#.])([^#.:]+)$/.exec(address);
  if (!match) return undefined;
  const [, owner, separator, member] = match;
  return `${owner}${separator === "#" ? "." : "#"}${member}`;
}

/** The answering id when it is `address` under the other `#`/`.` separator. */
function resolvedAsOf(address: string, result: ExploreResult): string | undefined {
  const symbolId = result.payload?.symbolId;
  if (typeof symbolId !== "string" || symbolId === address) return undefined;
  const separatorBlind = (id: string): string => id.replace(/[#.]/g, "#");
  return separatorBlind(symbolId) === separatorBlind(address) ? symbolId : undefined;
}
