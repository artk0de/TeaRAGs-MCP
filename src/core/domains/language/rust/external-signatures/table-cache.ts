/**
 * A project's Rust external signature table, built from the injected sources
 * port (bd s3i8m.7 T2). std/core/alloc are one extraction per toolchain; each
 * dependency crate is its own extraction WITHOUT std (its std references stay
 * spelled as absolute paths). Each is cached on disk under an extractor-
 * versioned key, so a warm pass parses nothing; the parts merge into one
 * lookup whose `identity` digests every input that can change an answer.
 *
 * Disk and toolchain live behind `RustExternalSignatureSources`; this leaf
 * only extracts, merges and digests.
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

import {
  createIdentifierRecord,
  type AstNode,
  type RustExternalFunction,
  type RustExternalSignatureSources,
  type RustExternalSignatureTable,
  type RustExternalSignatureTableData,
  type RustExternalSourceSet,
  type RustExternalTypeExpr,
  type RustExternalTypeSignatures,
} from "../../../../contracts/index.js";
import { extractRustExternalSignatures, type RustSourceParser } from "./extract.js";
import { RustExternalSignatureLookup } from "./lookup.js";

/**
 * Bump when the extractor's output for the same sources changes: it is part of
 * every cache key, so a bump invalidates every cached table at once.
 */
export const RUST_EXTERNAL_SIGNATURE_EXTRACTOR_VERSION = 2;

/** Loads a Rust parser on first use — sync, so the resolve pass stays sync. */
export type RustSourceParserLoader = () => RustSourceParser;

interface TreeSitterParser {
  setLanguage: (language: unknown) => void;
  parse: (source: string) => { rootNode: AstNode };
}

const requireGrammar = createRequire(import.meta.url);

/** The shipped `tree-sitter-rust` grammar behind one parser, loaded synchronously. */
export function loadRustSourceParser(): RustSourceParser {
  const Parser = requireGrammar("tree-sitter") as new () => TreeSitterParser;
  const parser = new Parser();
  parser.setLanguage(requireGrammar("tree-sitter-rust"));
  return (source) => parser.parse(source).rootNode;
}

export function buildRustExternalSignatureTable(
  sources: RustExternalSignatureSources,
  projectRoot: string,
  loadParser: RustSourceParserLoader,
): RustExternalSignatureTable | undefined {
  const found = sources.locate(projectRoot);
  let parse: RustSourceParser | undefined;
  const parser = (): RustSourceParser => (parse ??= loadParser());
  const parts: RustExternalSignatureTableData[] = [];
  const loadedKeys: string[] = [];
  const sets = [...(found.std === undefined ? [] : [found.std]), ...found.dependencies];
  for (const set of sets) {
    const data = cachedOrExtracted(sources, set, parser);
    if (data === undefined) continue;
    parts.push(data);
    loadedKeys.push(set.cacheKey);
  }
  if (parts.length === 0) return undefined;
  const identity = createHash("sha256")
    .update(
      JSON.stringify([
        RUST_EXTERNAL_SIGNATURE_EXTRACTOR_VERSION,
        found.std?.cacheKey ?? "absent",
        found.lockDigest ?? "absent",
        [...loadedKeys].sort(),
        sources.sizeCapBytes,
      ]),
    )
    .digest("hex");
  return new RustExternalSignatureLookup(mergeRustExternalSignatureData(parts), identity);
}

function cachedOrExtracted(
  sources: RustExternalSignatureSources,
  set: RustExternalSourceSet,
  parser: () => RustSourceParser,
): RustExternalSignatureTableData | undefined {
  const key = `${set.cacheKey}-x${RUST_EXTERNAL_SIGNATURE_EXTRACTOR_VERSION}`;
  const cached = sources.readCached(key);
  if (cached !== undefined) return cached;
  const files = set.readSources();
  if (files === undefined) return undefined;
  const data = extractRustExternalSignatures(files, parser());
  sources.writeCached(key, data);
  return data;
}

/**
 * One table over independently extracted parts. Keys are crate-prefixed
 * canonical paths, so parts never overlap; were one to, the earlier part
 * (std first, then dependencies by cache key) wins.
 */
function mergeRustExternalSignatureData(
  parts: readonly RustExternalSignatureTableData[],
): RustExternalSignatureTableData {
  if (parts.length === 1 && parts[0] !== undefined) return parts[0];
  const paths = createIdentifierRecord<string>();
  const types = createIdentifierRecord<RustExternalTypeSignatures>();
  const aliases = createIdentifierRecord<RustExternalTypeExpr>();
  const functionPaths = createIdentifierRecord<string>();
  const functions = createIdentifierRecord<RustExternalFunction | "ambiguous">();
  const crates = new Set<string>();
  for (const part of parts) {
    for (const crate of part.crates) crates.add(crate);
    mergeAbsent(paths, part.paths);
    mergeAbsent(types, part.types);
    mergeAbsent(aliases, part.aliases);
    mergeAbsent(functionPaths, part.functionPaths ?? {});
    mergeAbsent(functions, part.functions ?? {});
  }
  return { crates: [...crates], paths, types, aliases, functionPaths, functions };
}

function mergeAbsent<T>(target: Record<string, T>, source: Readonly<Record<string, T>>): void {
  for (const [key, value] of Object.entries(source)) {
    if (!Object.hasOwn(target, key)) target[key] = value;
  }
}

/**
 * The table of the project a pass resolves. Single-entry, like the workspace
 * crate map: `reload` is what `prepareResolvePass` calls, so every pass sees
 * the toolchain and lock as they are now (the disk cache makes that cheap).
 * Without an injected sources port there is nothing to load.
 */
export class RustExternalSignatureTableCache {
  private bound: { root: string; table: RustExternalSignatureTable | undefined } | undefined;

  constructor(
    private readonly sources?: RustExternalSignatureSources,
    private readonly loadParser: RustSourceParserLoader = loadRustSourceParser,
  ) {}

  forRoot(root: string | undefined): RustExternalSignatureTable | undefined {
    if (root === undefined || this.sources === undefined) return undefined;
    if (this.bound?.root !== root) this.reload(root);
    return this.bound?.table;
  }

  reload(root: string | undefined): void {
    if (root === undefined || this.sources === undefined) return;
    this.bound = { root, table: buildRustExternalSignatureTable(this.sources, root, this.loadParser) };
  }
}
