/**
 * Scoped chunk-set bumps (bd tea-rags-mcp-j4oww) — the ONE judgement both sides
 * of a scoped `--force` read.
 *
 * `LanguageVersionDriftMonitor` asks "which files do the pending bumps need
 * re-chunked?" to render the minimal `Run:` line; `IndexingOps` asks "which
 * pending bumps did this finished run's selection cover?" to advance the stamp.
 * Two implementations would disagree the way the stats contract's once did
 * (`stats-contract-drift.ts`): a report no run clears, or a stamp advanced over
 * files that were never re-chunked. Pure — no stamp is read or written here.
 *
 * The stamp stays per language and per axis: `chunking: k` claims every
 * revision up to k was applied to every file of the language. A scoped run
 * advances it to the highest revision such that it covered EVERY pending
 * revision up to it, which is exactly the claim it can back.
 */

import { SHARED_LANGUAGE, type LanguageCodeVersions } from "../../../contracts/types/language.js";
import {
  isRestrictingRechunkSelector,
  type ChunkSetBumpScope,
  type ChunkSetBumpScopes,
  type RechunkFileSelector,
} from "../../../contracts/types/rechunk.js";

/** The seed an unstamped integer axis is read as — see `LanguageVersionDriftMonitor`. */
const SEEDED_CHUNKING = 1;

/**
 * The scope of each pending `chunking` revision (`undefined` = unscoped), from
 * the stamp up to the build. A build BEHIND its stamp is a rollback whose
 * effect nothing declares, so it is one unscoped bump.
 */
export function pendingChunkingBumps(
  indexed: Partial<LanguageCodeVersions>,
  current: LanguageCodeVersions,
  scopes: ChunkSetBumpScopes | undefined,
): (ChunkSetBumpScope | undefined)[] {
  const from = indexed.chunking ?? SEEDED_CHUNKING;
  if (current.chunking < from) return [undefined];
  const pending: (ChunkSetBumpScope | undefined)[] = [];
  for (let revision = from + 1; revision <= current.chunking; revision++) pending.push(scopes?.chunking?.[revision]);
  return pending;
}

/** The scope of a pending grammar upgrade — keyed by the version upgraded TO. */
export function pendingGrammarBump(
  current: LanguageCodeVersions,
  scopes: ChunkSetBumpScopes | undefined,
): ChunkSetBumpScope | undefined {
  return current.grammar === undefined ? undefined : scopes?.grammar?.[current.grammar];
}

/**
 * The minimal selector re-chunking what these pending bumps of one language
 * touched, or `undefined` when any of them is unscoped — then only the plain
 * `--force` is honest. `*` stands for every language, so it adds no
 * `languages` narrowing.
 */
export function chunkSetBumpSelector(
  language: string,
  pending: readonly (ChunkSetBumpScope | undefined)[],
): RechunkFileSelector | undefined {
  if (pending.length === 0 || pending.some((scope) => scope === undefined)) return undefined;
  const languageSelector: RechunkFileSelector = language === SHARED_LANGUAGE ? {} : { languages: [language] };
  let combined: RechunkFileSelector | undefined = { ...languageSelector, ...pending[0] };
  for (const scope of pending.slice(1)) {
    if (combined === undefined) return undefined;
    combined = combineRechunkSelectors(combined, { ...languageSelector, ...scope });
  }
  return combined;
}

/**
 * The narrowest ONE command selecting everything either selector selects.
 * A command's filters are a conjunction, so a union of two is only exact when
 * they differ in one dimension; otherwise every dimension they disagree on is
 * dropped — a superset re-chunks extra files, never too few. `undefined` means
 * unrestricted: nothing narrow enough is left, so the plain `--force` it is.
 */
export function combineRechunkSelectors(
  a: RechunkFileSelector,
  b: RechunkFileSelector,
): RechunkFileSelector | undefined {
  const combined: RechunkFileSelector = {
    ...(a.languages && b.languages ? { languages: sortedUnion(a.languages, b.languages) } : {}),
    ...(a.testFile !== undefined && a.testFile === b.testFile ? { testFile: a.testFile } : {}),
    ...(a.pathPattern !== undefined && a.pathPattern === b.pathPattern ? { pathPattern: a.pathPattern } : {}),
    ...(a.fileExtensions && b.fileExtensions
      ? { fileExtensions: sortedUnion(a.fileExtensions, b.fileExtensions) }
      : {}),
    ...(a.files && b.files ? { files: sortedUnion(a.files, b.files) } : {}),
  };
  return isRestrictingRechunkSelector(combined) ? combined : undefined;
}

/**
 * Did a run with this selection re-chunk every file the bump touched?
 * Conservative: a `false` costs a re-run, a wrong `true` hides stale chunks.
 * An explicit file list proves nothing about files it does not name.
 */
export function rechunkSelectorCovers(
  run: RechunkFileSelector,
  language: string,
  scope: ChunkSetBumpScope | undefined,
): boolean {
  if (run.files && run.files.length > 0) return false;
  if (run.languages && run.languages.length > 0) {
    if (language === SHARED_LANGUAGE) return false;
    if (!run.languages.some((name) => name.trim().toLowerCase() === language)) return false;
  }
  if (run.testFile !== undefined && run.testFile !== scope?.testFile) return false;
  if (run.pathPattern !== undefined && run.pathPattern !== scope?.pathPattern) return false;
  if (run.fileExtensions && run.fileExtensions.length > 0) {
    const runExtensions = new Set(run.fileExtensions.map(normalizeExtension));
    if (!scope?.fileExtensions?.every((ext) => runExtensions.has(normalizeExtension(ext)))) {
      return false;
    }
  }
  return true;
}

/**
 * The chunk-set axes a finished scoped run may advance for one language.
 * Empty when it covered nothing new.
 */
export function advanceChunkSetStamp(
  language: string,
  indexed: Partial<LanguageCodeVersions>,
  current: LanguageCodeVersions,
  scopes: ChunkSetBumpScopes | undefined,
  run: RechunkFileSelector,
): Partial<LanguageCodeVersions> {
  const advanced: Partial<LanguageCodeVersions> = {};

  const from = indexed.chunking ?? SEEDED_CHUNKING;
  if (current.chunking < from) {
    if (rechunkSelectorCovers(run, language, undefined)) advanced.chunking = current.chunking;
  } else {
    let reached = from;
    for (const scope of pendingChunkingBumps(indexed, current, scopes)) {
      if (!rechunkSelectorCovers(run, language, scope)) break;
      reached++;
    }
    if (reached > from) advanced.chunking = reached;
  }

  if (current.grammar !== undefined && indexed.grammar !== current.grammar) {
    // An unstamped grammar is unknown, not a declared upgrade: only a run that
    // re-chunked the whole language may claim it.
    const scope = indexed.grammar === undefined ? undefined : pendingGrammarBump(current, scopes);
    if (rechunkSelectorCovers(run, language, scope)) advanced.grammar = current.grammar;
  }

  return advanced;
}

function sortedUnion(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b])].sort();
}

function normalizeExtension(extension: string): string {
  const trimmed = extension.trim().toLowerCase();
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}
