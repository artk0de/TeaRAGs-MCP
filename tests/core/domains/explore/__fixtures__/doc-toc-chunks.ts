/**
 * Documentation chunk shapes copied from the tea-rags self-index
 * (tea-rags-mcp-mypsl): ids, symbolIds, line ranges and headingPath arrays are
 * the live payloads; only content is abbreviated.
 *
 * `search-cascade.md` opens with `# Search Cascade` immediately followed by
 * `## Principles`, so the H1 owns no chunk — it exists only as the ancestor
 * entry `[H1]` of every section's `[H1, H2]` headingPath. `index-freshness.md`
 * opens with an H1 carrying intro text, so that H1 owns a `[H1]` chunk. An
 * oversized section arrives as several windows sharing one symbolId and one
 * headingPath.
 */

import type { ScrollChunk } from "../../../../../src/core/domains/explore/chunk-grouping/types.js";

export const SEARCH_CASCADE_PATH = ".claude-plugin/tea-rags/rules/search-cascade.md";
export const INDEX_FRESHNESS_PATH = ".claude-plugin/tea-rags/rules/index-freshness.md";

const SEARCH_CASCADE = "Search Cascade";
const AFTER_SEARCH = "After-Search Navigation (READ BEFORE FINISHING ANY SEARCH)";
const FIND_SYMBOL = "find_symbol — the navigation workhorse (two addressing modes)";
const INDEX_FRESHNESS = "Index Freshness — reindex triggers";
const WORKTREE_CLONE = "Worktree-clone lifecycle (explicit, plan execution)";

interface DocSectionShape {
  id: string;
  symbolId: string;
  relativePath: string;
  headingPath: [depth: number, text: string][];
  startLine: number;
  endLine: number;
  chunkIndex: number;
}

function docChunk(shape: DocSectionShape): ScrollChunk {
  const [ownDepth, ownText] = shape.headingPath[shape.headingPath.length - 1];
  return {
    id: shape.id,
    payload: {
      relativePath: shape.relativePath,
      fileExtension: ".md",
      language: "markdown",
      isDocumentation: true,
      chunkType: "block",
      name: ownText,
      parentSymbolId: shape.relativePath,
      symbolId: shape.symbolId,
      chunkIndex: shape.chunkIndex,
      headingPath: shape.headingPath.map(([depth, text]) => ({ depth, text })),
      content: `${"#".repeat(ownDepth)} ${ownText}\n\n${ownText} body`,
      startLine: shape.startLine,
      endLine: shape.endLine,
      git: { file: { commitCount: 33, ageDays: 0 } },
    },
  };
}

/** Sections of `search-cascade.md`; the After-Search section is split into two windows. */
export function searchCascadeChunks(): ScrollChunk[] {
  const relativePath = SEARCH_CASCADE_PATH;
  return [
    docChunk({
      id: "73b39f25-3057-3aa4-3401-3e42c8343f37",
      symbolId: "doc:1e20e341ac6b",
      relativePath,
      headingPath: [
        [1, SEARCH_CASCADE],
        [2, "Principles"],
      ],
      startLine: 3,
      endLine: 33,
      chunkIndex: 0,
    }),
    docChunk({
      id: "01903b1d-3dc2-35aa-346c-dd8ec7e0217b",
      symbolId: "doc:695db51d8cf6",
      relativePath,
      headingPath: [
        [1, SEARCH_CASCADE],
        [2, "Tool Invocation Under Deferred Loading"],
      ],
      startLine: 34,
      endLine: 49,
      chunkIndex: 1,
    }),
    docChunk({
      id: "1c498713-9732-93cc-2125-8a55c6ee1af1",
      symbolId: "doc:447d443a09c8",
      relativePath,
      headingPath: [
        [1, SEARCH_CASCADE],
        [2, AFTER_SEARCH],
      ],
      startLine: 92,
      endLine: 115,
      chunkIndex: 4,
    }),
    docChunk({
      id: "after-search-window-2",
      symbolId: "doc:447d443a09c8",
      relativePath,
      headingPath: [
        [1, SEARCH_CASCADE],
        [2, AFTER_SEARCH],
      ],
      startLine: 110,
      endLine: 137,
      chunkIndex: 5,
    }),
    docChunk({
      id: "544b63bc-03fc-e93d-5dfe-1a2a40f48413",
      symbolId: "doc:cc3d89fa37bb",
      relativePath,
      headingPath: [
        [1, SEARCH_CASCADE],
        [2, AFTER_SEARCH],
        [3, FIND_SYMBOL],
      ],
      startLine: 145,
      endLine: 173,
      chunkIndex: 6,
    }),
  ];
}

/** TOC of {@link searchCascadeChunks}: the chunkless H1 is listed without an id. */
export const SEARCH_CASCADE_TOC = [
  "# Search Cascade",
  "  ## Principles  doc:1e20e341ac6b",
  "  ## Tool Invocation Under Deferred Loading  doc:695db51d8cf6",
  `  ## ${AFTER_SEARCH}  doc:447d443a09c8`,
  `    ### ${FIND_SYMBOL}  doc:cc3d89fa37bb`,
].join("\n");

/** Sections of `index-freshness.md`: an H1 with its own intro chunk, then a two-window H2. */
export function indexFreshnessChunks(): ScrollChunk[] {
  const relativePath = INDEX_FRESHNESS_PATH;
  return [
    docChunk({
      id: "5753c2c9-49f8-8493-267f-9fd9c91adb78",
      symbolId: "doc:c629b097bf0e",
      relativePath,
      headingPath: [[1, INDEX_FRESHNESS]],
      startLine: 1,
      endLine: 13,
      chunkIndex: 0,
    }),
    docChunk({
      id: "5cc7fed1-eb75-4413-20d0-02530113cc55",
      symbolId: "doc:a4245701076e",
      relativePath,
      headingPath: [
        [1, INDEX_FRESHNESS],
        [2, WORKTREE_CLONE],
      ],
      startLine: 14,
      endLine: 28,
      chunkIndex: 1,
    }),
    docChunk({
      id: "worktree-clone-window-2",
      symbolId: "doc:a4245701076e",
      relativePath,
      headingPath: [
        [1, INDEX_FRESHNESS],
        [2, WORKTREE_CLONE],
      ],
      startLine: 24,
      endLine: 36,
      chunkIndex: 2,
    }),
  ];
}

/** TOC of {@link indexFreshnessChunks}: the H1 owns a chunk and keeps its id. */
export const INDEX_FRESHNESS_TOC = [
  `# ${INDEX_FRESHNESS}  doc:c629b097bf0e`,
  `  ## ${WORKTREE_CLONE}  doc:a4245701076e`,
].join("\n");

/** Every `doc:<hash>` id rendered on a TOC, one entry per line that carries one. */
export function tocDocIds(toc: string): string[] {
  return toc.split("\n").flatMap((line) => line.match(/doc:[0-9a-f]+$/) ?? []);
}
