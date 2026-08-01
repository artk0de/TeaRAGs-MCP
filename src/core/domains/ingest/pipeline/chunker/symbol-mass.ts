/**
 * Symbol-mass post-pass — spec
 * `docs/superpowers/specs/2026-08-01-risk-assessment-structural-axis-design.md` §A.
 *
 * Stamps three structural fields on a single file's assembled chunk array:
 *
 * | Field             | On                      | Meaning                                |
 * | ----------------- | ----------------------- | -------------------------------------- |
 * | `memberCount`     | class chunks            | distinct member symbolIds of the class |
 * | `classLines`      | class chunks            | real class span, not the header span   |
 * | `fileSymbolCount` | every code chunk (flat) | distinct code symbolIds in the file    |
 *
 * One language-independent pass rather than nine per-language hooks: it reads
 * only `symbolId` / `parentSymbolId` / `chunkType` / line span, which every
 * chunker already emits. It runs at the FileProcessor seam, after
 * `parentSymbolId` resolution and doc-symbolId assignment, so the tree-sitter
 * chunker, the markdown chunker and the character fallback are all covered.
 *
 * Why a post-pass at all: a class chunk carries only the header (measured on
 * the live index — `Reranker` spans lines 77–738 while its class chunk covers
 * the header alone), so class mass is invisible without looking at the class's
 * members, which live in sibling chunks.
 */

import type { CodeChunk } from "../../../../types.js";

/**
 * Trailing suffix `enforceMaxChunkSize` appends when it splits an oversized
 * chunk into parts. All parts of one symbol fold back to that symbol.
 */
const PART_SUFFIX = /#part\d+$/;

/** Defensive bound on the ancestor walk; real nesting never approaches it. */
const MAX_ANCESTOR_DEPTH = 64;

interface ClassMass {
  /** Lowest startLine among chunks carrying this class symbolId. */
  startLine: number;
  /** Highest endLine reached by the class or anything nested inside it. */
  maxEndLine: number;
  /** Distinct folded symbolIds of the class's DIRECT members. */
  members: Set<string>;
  /** Folded `parentSymbolId` of the class chunk, for the ancestor walk. */
  parentId: string | undefined;
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

function indexClasses(codeChunks: CodeChunk[]): Map<string, ClassMass> {
  const classes = new Map<string, ClassMass>();
  for (const chunk of codeChunks) {
    if (chunk.metadata.chunkType !== "class") continue;
    const id = foldedId(chunk.metadata.symbolId);
    if (!id) continue;
    const existing = classes.get(id);
    if (existing) {
      existing.startLine = Math.min(existing.startLine, chunk.startLine);
      existing.maxEndLine = Math.max(existing.maxEndLine, chunk.endLine);
      continue;
    }
    classes.set(id, {
      startLine: chunk.startLine,
      maxEndLine: chunk.endLine,
      members: new Set<string>(),
      parentId: foldedId(chunk.metadata.parentSymbolId),
    });
  }
  return classes;
}

/**
 * Innermost class owning `parentId`.
 *
 * An exact hit is the common case (a method's `parentSymbolId` IS the class
 * symbolId). The prefix branch covers ids that name a MEMBER rather than a
 * class: split parts point at their unsplit sibling's symbolId, and nested
 * blocks point at the enclosing member. Those belong to the longest class
 * symbolId that prefixes them at a symbol boundary — any non-word character,
 * so `#`, `.` and `::` all qualify without this module knowing which
 * separator a language uses. The boundary check is what keeps class `Alpha`
 * from swallowing the unrelated top-level `AlphaHelper`.
 */
function resolveOwner(parentId: string | undefined, classes: Map<string, ClassMass>): string | undefined {
  if (!parentId) return undefined;
  if (classes.has(parentId)) return parentId;
  let best: string | undefined;
  for (const id of classes.keys()) {
    if (parentId.length <= id.length || !parentId.startsWith(id)) continue;
    if (/\w/.test(parentId.charAt(id.length))) continue;
    if (best === undefined || id.length > best.length) best = id;
  }
  return best;
}

/**
 * Attribute each chunk to its owning class: membership at the first level
 * only (a nested class's methods are members of the nested class, per spec),
 * span extension all the way up the ancestor chain (an outer class's real
 * span still has to cover everything nested inside it).
 */
function attributeChunks(codeChunks: CodeChunk[], classes: Map<string, ClassMass>): void {
  for (const chunk of codeChunks) {
    const ownerId = resolveOwner(foldedId(chunk.metadata.parentSymbolId), classes);
    if (!ownerId) continue;
    const memberId = foldedId(chunk.metadata.symbolId);

    const visited = new Set<string>();
    let currentId: string | undefined = ownerId;
    let depth = 0;
    while (currentId !== undefined && !visited.has(currentId) && depth < MAX_ANCESTOR_DEPTH) {
      visited.add(currentId);
      depth++;
      const current = classes.get(currentId);
      /* v8 ignore next -- resolveOwner only ever returns indexed class ids */
      if (!current) break;
      current.maxEndLine = Math.max(current.maxEndLine, chunk.endLine);
      if (currentId === ownerId && memberId !== undefined && memberId !== currentId) {
        current.members.add(memberId);
      }
      currentId = resolveOwner(current.parentId, classes);
    }
  }
}

/**
 * Compute and stamp symbol-mass metadata for one file's chunks. Mutates in
 * place; safe to call on any chunk array, including an all-documentation one
 * (nothing is stamped) and an empty one.
 */
export function assignSymbolMass(chunks: CodeChunk[]): void {
  const codeChunks = chunks.filter(isCodeChunk);
  if (codeChunks.length === 0) return;

  const fileSymbols = new Set<string>();
  for (const chunk of codeChunks) {
    const id = foldedId(chunk.metadata.symbolId);
    if (id) fileSymbols.add(id);
  }

  const classes = indexClasses(codeChunks);
  attributeChunks(codeChunks, classes);

  for (const chunk of codeChunks) {
    chunk.metadata.fileSymbolCount = fileSymbols.size;
    if (chunk.metadata.chunkType !== "class") continue;
    const id = foldedId(chunk.metadata.symbolId);
    const mass = id ? classes.get(id) : undefined;
    if (!mass) continue;
    chunk.metadata.memberCount = mass.members.size;
    chunk.metadata.classLines = Math.max(0, mass.maxEndLine - mass.startLine);
  }
}
