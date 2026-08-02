/**
 * Symbol-mass post-pass — spec
 * `docs/superpowers/specs/2026-08-02-module-mass-signals-design.md`.
 *
 * Stamps three structural fields on a single file's assembled chunk array:
 *
 * | Field             | On                      | Meaning                              |
 * | ----------------- | ----------------------- | ------------------------------------ |
 * | `moduleLines`     | every code chunk (flat) | physical line count of the file      |
 * | `moduleMethodCount` | every code chunk (flat) | distinct callables declared in file  |
 * | `memberCount`     | one chunk per container | distinct direct members of the class |
 *
 * One language-independent pass rather than nine per-language hooks: it reads
 * only `symbolId` / `parentSymbolId` / `parentType` / `chunkType` / line span,
 * which every chunker already emits. It runs at the FileProcessor seam, after
 * `parentSymbolId` resolution and doc-symbolId assignment, so the tree-sitter
 * chunker, the markdown chunker and the character fallback are all covered.
 *
 * Why containers are indexed by `parentType` rather than `chunkType`: a class
 * WITH members emits no `chunkType: "class"` chunk at all in TypeScript — the
 * body-chunker hook (`typescript/chunking/class-body-chunker.ts`) writes
 * `ctx.bodyChunks` carrying no chunkType, so every chunk lands as `"block"`.
 * Selecting on `chunkType` therefore saw only the member-LESS classes: 37
 * chunks against 418 class declarations on the live tea-rags index, which made
 * every percentile derived from the signal meaningless.
 */

import type { CodeChunk } from "../../../../types.js";

/**
 * Trailing suffix `enforceMaxChunkSize` appends when it splits an oversized
 * chunk into parts. All parts of one symbol fold back to that symbol.
 */
const PART_SUFFIX = /#part\d+$/;

/**
 * Chunk types that denote a CALLABLE — the unit `moduleMethodCount` counts. Type
 * declarations (`interface`, class headers, `block`) are deliberately absent: a
 * barrel of interfaces declares no behavior, and counting it as module mass
 * flagged type-only files as god modules.
 */
const CALLABLE_CHUNK_TYPES = new Set(["function", "test", "test_setup"]);

/**
 * A `parentType` naming this node as a member CONTAINER. Mirrors the node-type
 * test `TreeSitterChunker.getChunkType` applies, so Ruby `module`, Go
 * `struct_type` and the TS/Java/Python `class_declaration` family are all
 * covered without per-language knowledge here.
 */
const CONTAINER_PARENT_TYPE = /class|module|struct/;

interface ContainerMass {
  /** Lowest startLine seen among chunks belonging to this container. */
  representativeLine: number;
  /** Index into the code-chunk array of the chunk at `representativeLine`. */
  representativeIndex: number;
  /** Distinct folded symbolIds of the container's DIRECT members. */
  members: Set<string>;
}

function foldPartSuffix(symbolId: string): string {
  return symbolId.replace(PART_SUFFIX, "");
}

function foldedId(symbolId: string | undefined): string | undefined {
  return symbolId ? foldPartSuffix(symbolId) : undefined;
}

/**
 * Documentation chunks are excluded from both storage and counting: their
 * `doc:` symbolIds are content hashes, not code symbols.
 */
function isCodeChunk(chunk: CodeChunk): boolean {
  return chunk.metadata.isDocumentation !== true && chunk.metadata.symbolId?.startsWith("doc:") !== true;
}

/**
 * Every container declared in the file, from BOTH shapes a chunker produces: a
 * standalone container chunk (`chunkType: "class"` — the member-less case), and
 * a member chunk pointing back at its container through `parentSymbolId` plus a
 * container-shaped `parentType` (the body-chunker case).
 */
function indexContainers(codeChunks: CodeChunk[]): Map<string, ContainerMass> {
  const containers = new Map<string, ContainerMass>();

  const declare = (id: string): void => {
    if (containers.has(id)) return;
    containers.set(id, {
      representativeLine: Number.POSITIVE_INFINITY,
      representativeIndex: -1,
      members: new Set<string>(),
    });
  };

  for (const chunk of codeChunks) {
    if (chunk.metadata.chunkType === "class") {
      const id = foldedId(chunk.metadata.symbolId);
      if (id) declare(id);
      continue;
    }
    const parentId = foldedId(chunk.metadata.parentSymbolId);
    const { parentType } = chunk.metadata;
    if (parentId && parentType && CONTAINER_PARENT_TYPE.test(parentType)) declare(parentId);
  }

  return containers;
}

/**
 * Innermost container owning `parentId`.
 *
 * An exact hit is the common case (a method's `parentSymbolId` IS the container
 * symbolId). The prefix branch covers ids that name a MEMBER rather than a
 * container: split parts point at their unsplit sibling's symbolId, and nested
 * blocks point at the enclosing member. Those belong to the longest container
 * symbolId that prefixes them at a symbol boundary — any non-word character, so
 * `#`, `.` and `::` all qualify without this module knowing which separator a
 * language uses. The boundary check is what keeps container `Alpha` from
 * swallowing the unrelated top-level `AlphaHelper`.
 */
function resolveOwner(parentId: string | undefined, containers: Map<string, ContainerMass>): string | undefined {
  if (!parentId) return undefined;
  if (containers.has(parentId)) return parentId;
  let best: string | undefined;
  for (const id of containers.keys()) {
    if (parentId.length <= id.length || !parentId.startsWith(id)) continue;
    if (/\w/.test(parentId.charAt(id.length))) continue;
    if (best === undefined || id.length > best.length) best = id;
  }
  return best;
}

/**
 * Attribute each chunk to its owning container: membership at the first level
 * only (a nested container's methods are members of the nested container, per
 * spec), and elect the chunk that REPRESENTS each container — the lowest
 * `startLine` among the chunks belonging to it, which is where `memberCount`
 * gets stamped. First chunk wins a tie, so a container chunk sharing a line
 * with its first member stays the representative.
 *
 * One value per container is what keeps the percentile honest: stamping every
 * chunk of a class would let a 40-chunk class outvote every other class in its
 * own distribution.
 */
function attributeChunks(codeChunks: CodeChunk[], containers: Map<string, ContainerMass>): void {
  codeChunks.forEach((chunk, index) => {
    const ownId = foldedId(chunk.metadata.symbolId);
    const ownerId = resolveOwner(foldedId(chunk.metadata.parentSymbolId), containers);

    // A chunk can both BE a container and belong to an outer one; each role
    // contributes a representative candidate.
    for (const containerId of [ownId, ownerId]) {
      if (containerId === undefined) continue;
      const container = containers.get(containerId);
      if (!container || chunk.startLine >= container.representativeLine) continue;
      container.representativeLine = chunk.startLine;
      container.representativeIndex = index;
    }

    if (ownerId === undefined || ownId === undefined || ownId === ownerId) return;
    /* v8 ignore next -- resolveOwner only ever returns indexed container ids */
    containers.get(ownerId)?.members.add(ownId);
  });
}

/** Distinct callables declared in the file, split chunks folded into one. */
function countCallables(codeChunks: CodeChunk[]): number {
  const callables = new Set<string>();
  for (const chunk of codeChunks) {
    const { chunkType } = chunk.metadata;
    if (!chunkType || !CALLABLE_CHUNK_TYPES.has(chunkType)) continue;
    const id = foldedId(chunk.metadata.symbolId);
    if (id) callables.add(id);
  }
  return callables.size;
}

/**
 * Compute and stamp symbol-mass metadata for one file's chunks. Mutates in
 * place; safe to call on any chunk array, including an all-documentation one
 * (nothing is stamped) and an empty one.
 *
 * `code` is the file's source — `moduleLines` is its physical line count, the
 * same unit ESLint `max-lines` measures, so the per-language floors stay
 * directly comparable to published limits.
 */
export function assignSymbolMass(chunks: CodeChunk[], code: string): void {
  const codeChunks = chunks.filter(isCodeChunk);
  if (codeChunks.length === 0) return;

  const moduleLines = code.split("\n").length;
  const moduleMethodCount = countCallables(codeChunks);

  const containers = indexContainers(codeChunks);
  attributeChunks(codeChunks, containers);

  for (const chunk of codeChunks) {
    chunk.metadata.moduleLines = moduleLines;
    chunk.metadata.moduleMethodCount = moduleMethodCount;
  }

  for (const container of containers.values()) {
    if (container.representativeIndex < 0) continue;
    codeChunks[container.representativeIndex].metadata.memberCount = container.members.size;
  }
}
