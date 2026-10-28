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
import { BATCH_FULL_TEXT_MAX_LINES, type SymbolBatchMiss } from "../../contracts/types/symbol-batch.js";
import { Semaphore } from "../../primitives/concurrency/index.js";
import { lastNameSegment } from "../../primitives/ids/index.js";
import { containerMemberMessage, findContainerMembers, rankByNamespaceProximity } from "./member-miss.js";
import type { FileOutlineStrategy } from "./strategies/file-outline.js";
import type { SymbolSearchStrategy } from "./strategies/symbol.js";
import type { ExploreContext, ExploreResult } from "./strategies/types.js";
import { relativePathOf } from "./working-tree/index.js";

/** The next step an unknown address calls for — shared by a batch miss and a single-symbol `empty`. */
export const UNKNOWN_SYMBOL_HINT = "retry a partial address (Class or bare name), or hybrid_search";

/** The next step an unknown path entry calls for. */
const UNKNOWN_PATH_HINT = "retry a suggested path, or find_symbol(relativePath: <dir>)";

/** Said once per batch answer in which a path entry was outlined instead of read, or a directory refused. */
const BATCH_PATH_NOTICE =
  `paths answer as outline in a batch (full text only ≤${BATCH_FULL_TEXT_MAX_LINES} lines; ` +
  "a directory → missing) — read bodies by the member ids";

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

/** Addresses resolved at once — each one runs two Qdrant scrolls. */
const ADDRESS_CONCURRENCY = 4;

export interface SymbolBatchRow {
  /** The address as the caller wrote it. */
  request: string;
  /** The id that answered, when it differs from `request` only by the `#`/`.` separator. */
  resolvedAs?: string;
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
   * `outlineFor` answers a path entry (q1g6s.4) under a strict full-text line
   * cap — a file outline, not the text a single `relativePath:` may return
   * (yz10n); without it every entry is a symbol address.
   */
  constructor(
    private readonly strategyFor: (symbol: string) => SymbolSearchStrategy,
    private readonly outlineFor?: (relativePath: string, fullTextMaxLines: number) => FileOutlineStrategy,
  ) {}

  async execute(addresses: readonly string[], ctx: ExploreContext): Promise<SymbolBatchAnswer> {
    const slots = new Semaphore(ADDRESS_CONCURRENCY);
    const answers = await Promise.all(
      addresses.map(async (address) => {
        const release = await slots.acquire();
        try {
          return await this.resolve(address, ctx);
        } finally {
          release();
        }
      }),
    );
    return {
      rows: answers.flatMap((a) => a.rows),
      missing: answers.flatMap((a) => (a.miss ? [a.miss] : [])),
      ...firstWarning(answers),
      ...(answers.some((a) => a.pathDowngraded) ? { batchNotice: BATCH_PATH_NOTICE } : {}),
    };
  }

  private async resolve(address: string, ctx: ExploreContext): Promise<AddressAnswer> {
    if (this.outlineFor && isFilePathAddress(address)) {
      const outline = this.outlineFor(address, BATCH_FULL_TEXT_MAX_LINES);
      const results = await outline.execute(ctx);
      // A directory listing is a whole-tree read: refused here, answered by `relativePath:` alone.
      if (outline.directory) return { rows: [], miss: directoryEntryMiss(address), pathDowngraded: true };
      if (results.length > 0) {
        return {
          rows: results.map((result) => ({ request: address, result })),
          pathDowngraded: outline.fullTextWithheld,
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
  /** A path entry answered short of what `relativePath:` gives: outline for text, or a refused directory. */
  pathDowngraded?: boolean;
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
