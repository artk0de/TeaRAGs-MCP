#!/usr/bin/env tsx
/**
 * Phase 0 size census for the naming lexicon (bd tea-rags-mcp-4p3sb.7).
 *
 * Walks a project root the way production does — the codegraph harnesses'
 * shared corpus walk, so `.gitignore` / `.contextignore` and the codegraph
 * exclusion layer drop exactly what production drops — parses every kept file
 * with its language's COMPOSED walker over real chunk ranges, and aggregates
 * `FileExtraction.identifierDeclarations` into counters. Nothing is written to
 * the target tree and no extraction is retained past its own file, so memory
 * stays bounded by the distinct type-name vocabulary, not by the corpus.
 *
 * Usage: npx tsx scripts/identifier-declarations-census.ts <root>
 * Prints ONE JSON object on stdout.
 *
 * `estimatedBytes` is a naive upper bound on the `cg_identifiers` row payload:
 * Σ relPath + ownerSymbolId + name + typeName lengths + 24 fixed bytes per row.
 * DuckDB dictionary compression lands well below it.
 */
import { resolve as resolvePath } from "node:path";

import type { IdentifierDeclaration } from "../src/core/contracts/types/codegraph-extraction.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../src/core/domains/language/index.js";
import { CODEGRAPH_LANGUAGES } from "../src/core/domains/trajectory/codegraph/symbols/provider.js";
import {
  buildCorpusExclusionFilter,
  collectSourceFiles,
  extractFile,
  readCorpusDeclaredDependencies,
} from "./ts-codegraph-typechecker-oracle.js";

/** Fixed per-row overhead in the naive estimate: line, kind, typeSource, row framing. */
const ROW_FIXED_BYTES = 24;
const TOP_TYPE_NAMES = 10;
const FAILED_FILE_SAMPLE_CAP = 20;

export interface TypeNameCount {
  typeName: string;
  count: number;
}

export interface LanguageIdentifierCensus {
  param: number;
  local: number;
  field: number;
  typed: number;
  files: number;
  /** The ten most frequent stated types, most frequent first. */
  topTypeNames: TypeNameCount[];
  /** Declaration count per `typeSource`; untyped declarations are absent. */
  byTypeSource: Record<string, number>;
}

export interface FailedCensusFile {
  relPath: string;
  reason: string;
}

export interface IdentifierDeclarationsCensus {
  files: number;
  declarations: number;
  typed: number;
  byLanguage: Record<string, LanguageIdentifierCensus>;
  estimatedBytes: number;
  /** Files whose parse or walk threw — counted, never fatal. */
  parseFailures: number;
  /** First {@link FAILED_FILE_SAMPLE_CAP} failures with their reason. */
  failedFiles: FailedCensusFile[];
  /** Kept by the corpus walk but no walker for the extension. */
  unwalked: number;
  /** Dropped by `.gitignore` and friends. */
  ingestIgnored: number;
  /** Indexed for search but excluded from the codegraph (tests, generated). */
  codegraphExcluded: number;
  wallMs: number;
}

interface LanguageCounters {
  param: number;
  local: number;
  field: number;
  typed: number;
  files: number;
  typeNames: Map<string, number>;
  byTypeSource: Map<string, number>;
}

/** Aggregates per-file declarations into counters; holds no extraction. */
export class IdentifierDeclarationsCensusAccumulator {
  private files = 0;
  private declarations = 0;
  private typed = 0;
  private estimatedBytes = 0;
  private parseFailures = 0;
  private unwalked = 0;
  private readonly failedFiles: FailedCensusFile[] = [];
  private readonly byLanguage = new Map<string, LanguageCounters>();

  addFile(relPath: string, language: string, declarations: readonly IdentifierDeclaration[] | undefined): void {
    this.files++;
    const counters = this.countersFor(language);
    counters.files++;
    for (const declaration of declarations ?? []) {
      this.declarations++;
      counters[declaration.kind]++;
      this.estimatedBytes +=
        relPath.length +
        declaration.ownerSymbolId.length +
        declaration.name.length +
        (declaration.typeName?.length ?? 0) +
        ROW_FIXED_BYTES;
      if (declaration.typeName !== undefined) {
        this.typed++;
        counters.typed++;
        counters.typeNames.set(declaration.typeName, (counters.typeNames.get(declaration.typeName) ?? 0) + 1);
      }
      if (declaration.typeSource !== undefined) {
        counters.byTypeSource.set(declaration.typeSource, (counters.byTypeSource.get(declaration.typeSource) ?? 0) + 1);
      }
    }
  }

  fail(relPath: string, reason: string): void {
    this.parseFailures++;
    if (this.failedFiles.length < FAILED_FILE_SAMPLE_CAP) this.failedFiles.push({ relPath, reason });
  }

  skipUnwalked(): void {
    this.unwalked++;
  }

  result(
    wallMs: number,
    excluded: { ingestIgnored: number; codegraphExcluded: number } = { ingestIgnored: 0, codegraphExcluded: 0 },
  ): IdentifierDeclarationsCensus {
    const byLanguage: Record<string, LanguageIdentifierCensus> = {};
    for (const [language, c] of [...this.byLanguage].sort(([a], [b]) => a.localeCompare(b))) {
      byLanguage[language] = {
        param: c.param,
        local: c.local,
        field: c.field,
        typed: c.typed,
        files: c.files,
        topTypeNames: [...c.typeNames]
          .sort(([aName, aCount], [bName, bCount]) => bCount - aCount || aName.localeCompare(bName))
          .slice(0, TOP_TYPE_NAMES)
          .map(([typeName, count]) => ({ typeName, count })),
        byTypeSource: Object.fromEntries([...c.byTypeSource].sort(([a], [b]) => a.localeCompare(b))),
      };
    }
    return {
      files: this.files,
      declarations: this.declarations,
      typed: this.typed,
      byLanguage,
      estimatedBytes: this.estimatedBytes,
      parseFailures: this.parseFailures,
      failedFiles: [...this.failedFiles],
      unwalked: this.unwalked,
      ingestIgnored: excluded.ingestIgnored,
      codegraphExcluded: excluded.codegraphExcluded,
      wallMs: Math.round(wallMs),
    };
  }

  private countersFor(language: string): LanguageCounters {
    let counters = this.byLanguage.get(language);
    if (counters === undefined) {
      counters = { param: 0, local: 0, field: 0, typed: 0, files: 0, typeNames: new Map(), byTypeSource: new Map() };
      this.byLanguage.set(language, counters);
    }
    return counters;
  }
}

function describeError(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/** Walk `root` read-only and aggregate every composed walker's identifier declarations. */
export async function runIdentifierDeclarationsCensus(root: string): Promise<IdentifierDeclarationsCensus> {
  const started = performance.now();
  const composer = new DefaultSymbolIdComposer();
  const factory = new LanguageFactory({ repoRoot: root });
  const selection = await collectSourceFiles(
    root,
    root,
    await buildCorpusExclusionFilter(root, factory),
    Object.keys(CODEGRAPH_LANGUAGES),
  );
  // Read once per corpus, as production does at run start (w205u.1).
  const declaredDependencies = readCorpusDeclaredDependencies(root, factory);

  const accumulator = new IdentifierDeclarationsCensusAccumulator();
  for (const relPath of selection.kept) {
    let failure: unknown;
    let threw = false;
    const extraction = extractFile(root, relPath, composer, factory, declaredDependencies, (error) => {
      threw = true;
      failure = error;
    });
    if (extraction === null) {
      if (threw) accumulator.fail(relPath, describeError(failure));
      else accumulator.skipUnwalked();
      continue;
    }
    accumulator.addFile(relPath, extraction.language, extraction.identifierDeclarations);
  }
  return accumulator.result(performance.now() - started, selection);
}

async function main(): Promise<void> {
  const target = process.argv[2];
  if (target === undefined) {
    process.stderr.write("usage: npx tsx scripts/identifier-declarations-census.ts <root>\n");
    process.exitCode = 2;
    return;
  }
  const census = await runIdentifierDeclarationsCensus(resolvePath(target));
  process.stdout.write(`${JSON.stringify(census, null, 2)}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
}
