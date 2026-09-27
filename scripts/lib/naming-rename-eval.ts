/**
 * Pure core of the naming-lexicon rename eval (bd tea-rags-mcp-tun7x): reading
 * rename pairs out of commit messages, classifying what a rename changed, and
 * scoring one `get_naming_lexicon` type verdict against the rename its owner
 * later made. No I/O — the runner (`scripts/naming-rename-eval.ts`) owns git,
 * the filesystem and the tool call.
 *
 * Words are split with the tool's own {@link typeNameWords}, so "the word the
 * rename introduced" and "the word the tool offered" are compared in one
 * vocabulary.
 */
import { singularizeIdentifierWord, typeNameWords } from "../../src/core/domains/explore/naming-lexicon/casing.js";
import { mulberry32 } from "./py-oracle-core.js";

export interface RenamePair {
  oldName: string;
  newName: string;
}

/** A PascalCase type-like name: leading capital, at least one lowercase letter. */
const TYPE_NAME = "[A-Z][A-Za-z0-9]*[a-z][A-Za-z0-9]*";
const TICK = "`?";
/** `Old → New`, `Old -> New`, `Old→New`; the name must not be a `Class#member` / `Class.member` tail. */
const ARROW = `(?<![#.\\w])${TICK}(${TYPE_NAME})${TICK}\\s*(?:→|->)\\s*${TICK}(${TYPE_NAME})\\b(?![#.]\\w)`;
/** `rename Old to New`, `renamed Old into New`, `Renames Old as New`. */
const RENAME_VERB = `\\b[Rr]enam(?:e|ed|es|ing)\\s+(?:from\\s+)?${TICK}(${TYPE_NAME})${TICK}\\s+(?:to|into|as)\\s+${TICK}(${TYPE_NAME})\\b`;
/** `Old renamed to New`, `Old becomes New`. */
const PASSIVE = `\\b${TICK}(${TYPE_NAME})${TICK}\\s+(?:renamed\\s+to|becomes)\\s+${TICK}(${TYPE_NAME})\\b`;
const RENAME_PATTERNS = [ARROW, RENAME_VERB, PASSIVE].map((source) => new RegExp(source, "g"));

/** Every distinct `Old → New` type rename a commit message names, in order of first appearance. */
export function extractRenamePairs(message: string): RenamePair[] {
  const found: { index: number; pair: RenamePair }[] = [];
  for (const pattern of RENAME_PATTERNS) {
    for (const match of message.matchAll(pattern)) {
      const [, oldName, newName] = match;
      if (oldName === undefined || newName === undefined || oldName === newName) continue;
      found.push({ index: match.index, pair: { oldName, newName } });
    }
  }
  const seen = new Set<string>();
  return found
    .sort((a, b) => a.index - b.index)
    .flatMap(({ pair }) => {
      const key = `${pair.oldName}>${pair.newName}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [pair];
    });
}

export interface ScannedTypeDeclaration {
  name: string;
  /** The last segment of the first `extends` target (`ns.Parent<T>` → `Parent`). */
  extendsName?: string;
}

const DECLARATION =
  /^[ \t]*(?:export[ \t]+)?(?:declare[ \t]+)?(?:default[ \t]+)?(?:abstract[ \t]+)?(?:const[ \t]+)?(?:class|interface|type|enum)[ \t]+([A-Z][A-Za-z0-9]*)(?=[ \t]*(?:[<={]|extends\b|implements\b|$))([^\n]*)/gm;
const EXTENDS = /\bextends[ \t]+([A-Za-z_$][\w$.]*)/;

/**
 * The class / interface / type / enum declarations a TypeScript source starts a
 * line with. The name must be followed by what opens a declaration (`<`, `=`,
 * `{`, `extends`, `implements`, end of line), so a `type Foo,` specifier inside
 * a multi-line import list is not one.
 */
export function scanTypeDeclarations(source: string): ScannedTypeDeclaration[] {
  return [...source.matchAll(DECLARATION)].map((match) => {
    const extendsTarget = EXTENDS.exec(match[2] ?? "")?.[1];
    const extendsName = extendsTarget?.split(".").at(-1);
    return { name: match[1] ?? "", ...(extendsName ? { extendsName } : {}) };
  });
}

/**
 * The earliest commit time at which an ADDED patch line declares each type.
 * Input: `git log --format=%x1e%ct -p --unified=0` — records separated by
 * U+001E, each starting with the commit time.
 */
export function firstDeclarationTimes(log: string): Map<string, number> {
  const first = new Map<string, number>();
  for (const record of log.split("\u001e")) {
    const newline = record.indexOf("\n");
    const time = Number(newline === -1 ? record : record.slice(0, newline));
    if (!Number.isFinite(time) || record.trim() === "") continue;
    for (const line of record.split("\n")) {
      if (!line.startsWith("+") || line.startsWith("+++")) continue;
      for (const { name } of scanTypeDeclarations(line.slice(1))) {
        const known = first.get(name);
        if (known === undefined || time < known) first.set(name, time);
      }
    }
  }
  return first;
}

export interface RenameWordDiff {
  oldWords: string[];
  newWords: string[];
  /** Old words absent from the new name. */
  removed: string[];
  /** New words absent from the old name. */
  added: string[];
}

export function renameWordDiff(oldName: string, newName: string): RenameWordDiff {
  const oldWords = typeNameWords(oldName);
  const newWords = typeNameWords(newName);
  return {
    oldWords,
    newWords,
    removed: oldWords.filter((word) => !newWords.includes(word)),
    added: newWords.filter((word) => !oldWords.includes(word)),
  };
}

export type RenameClass = "head" | "qualifier" | "both" | "role-added" | "move";

/**
 * What a rename changed. `role-added`: the old head survives as a qualifier
 * under a head the old name lacked, and that head is the only word the rename
 * introduced (`PipelineBatchSize` → `BatchSizeController`) — the rename
 * supplied a role; qualifiers it DROPPED do not change the class.
 */
export function classifyRename(oldName: string, newName: string): RenameClass {
  const { oldWords, newWords, added } = renameWordDiff(oldName, newName);
  if (oldWords.join(" ") === newWords.join(" ")) return "move";
  const oldHead = oldWords.at(-1) ?? "";
  const newHead = newWords.at(-1) ?? "";
  if (added.length === 1 && added[0] === newHead && newWords.slice(0, -1).includes(oldHead)) {
    return "role-added";
  }
  const qualifiersSame = sameMultiset(oldWords.slice(0, -1), newWords.slice(0, -1));
  if (oldHead === newHead) return "qualifier";
  return qualifiersSame ? "head" : "both";
}

function sameMultiset(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join(" ") === [...b].sort().join(" ");
}

/** The fields of a `TermAlternative` the scorer reads. */
export interface EvalTermAlternative {
  word: string;
  slot?: "head";
  heads: string[];
  domains: string[];
  lift: number;
  similarity?: number;
  examples?: string[];
  replaces?: string;
}

/** A `get_naming_lexicon` type verdict as the tool prints it. */
export type EvalNamingVerdict =
  | { verdict: "CONFORMS"; alternatives?: EvalTermAlternative[] }
  | { verdict: "MISFIT"; suggestion: string; role?: { word: string; evidence: string; examples: string[] } }
  | { verdict: "NEW_TERM"; topTerms: string[]; alternatives?: EvalTermAlternative[] }
  | { verdict: "COLLISION"; existing: { symbolId: string; relPath: string } };

/** One `names[]` entry of the tool's answer. */
export type EvalNameVerdict = EvalNamingVerdict & { name: string };

/**
 * The verdicts and notices of one `node build/cli/index.js call
 * get_naming_lexicon` stdout, minus the CLI's `[tea-rags]` lifecycle lines.
 * A notice means part of the batch was judged without its evidence — a
 * `type-name alignment skipped` notice drops concept search and every
 * alternative by meaning for the rest of the batch — so the caller must not
 * score it.
 */
export function parseNamingLexiconOutput(stdout: string): { names: EvalNameVerdict[]; notices: string[] } {
  const body = stdout
    .split("\n")
    .filter((line) => !line.startsWith("[tea-rags]"))
    .join("\n");
  const parsed = JSON.parse(body.slice(body.indexOf("{"), body.lastIndexOf("}") + 1)) as {
    names?: EvalNameVerdict[];
    notices?: string[];
  };
  return { names: parsed.names ?? [], notices: parsed.notices ?? [] };
}

export type AlternativeMechanism = "head-by-meaning" | "spelling" | "path-word" | "lexical";

/**
 * Which producer offered an alternative, read off its shape (verdicts.ts):
 * a path term carries `replaces` with no `heads`, no `examples` and zero lift;
 * a head found by meaning carries `examples`; the remaining head is a spelling
 * variant; a qualifier alternative is a lifted established modifier.
 */
export function classifyAlternative(alternative: EvalTermAlternative): AlternativeMechanism {
  if (
    alternative.replaces !== undefined &&
    alternative.heads.length === 0 &&
    alternative.examples === undefined &&
    alternative.lift === 0
  ) {
    return "path-word";
  }
  if (alternative.slot === "head") return alternative.examples !== undefined ? "head-by-meaning" : "spelling";
  return "lexical";
}

export type NamingOutcome = "MISFIT" | "COLLISION" | "NEW_TERM+alt" | "NEW_TERM" | "CONFORMS+alt" | "CONFORMS";
/** Rename items: caught / flagged-other / silent. Control items: false-flag / clean. */
export type NamingScore = "caught" | "flagged-other" | "silent" | "false-flag" | "clean";

export interface ScoredNamingOutcome {
  outcome: NamingOutcome;
  score: NamingScore;
  /** The mechanisms that fired: `role:<evidence>`, an {@link AlternativeMechanism}, `collision`, `new-term`. */
  mechanisms: string[];
}

function sameWord(a: string, b: string): boolean {
  return singularizeIdentifierWord(a) === singularizeIdentifierWord(b);
}

/**
 * Scores one verdict. With a `pair` (a rename item): `caught` = a flag
 * pointing toward the new name — a MISFIT whose suggestion shares a word with
 * the words the rename introduced, or an alternative equal to one of them;
 * `flagged-other` = any other flag (MISFIT, COLLISION, NEW_TERM, an
 * alternative); `silent` = CONFORMS with no alternative. Without a pair (a
 * control item): `false-flag` = MISFIT or any alternative, else `clean`.
 */
export function scoreNamingOutcome(verdict: EvalNamingVerdict, pair?: RenamePair): ScoredNamingOutcome {
  const alternatives = "alternatives" in verdict ? (verdict.alternatives ?? []) : [];
  const withAlt = alternatives.length > 0;
  const outcome: NamingOutcome =
    verdict.verdict === "CONFORMS" || verdict.verdict === "NEW_TERM"
      ? withAlt
        ? `${verdict.verdict}+alt`
        : verdict.verdict
      : verdict.verdict;
  const mechanisms =
    verdict.verdict === "MISFIT"
      ? [`role:${verdict.role?.evidence ?? "unknown"}`]
      : verdict.verdict === "COLLISION"
        ? ["collision"]
        : withAlt
          ? [...new Set(alternatives.map(classifyAlternative))]
          : verdict.verdict === "NEW_TERM"
            ? ["new-term"]
            : [];

  if (pair === undefined) {
    const falseFlag = verdict.verdict === "MISFIT" || withAlt;
    return { outcome, score: falseFlag ? "false-flag" : "clean", mechanisms: falseFlag ? mechanisms : [] };
  }
  if (outcome === "CONFORMS") return { outcome, score: "silent", mechanisms };

  const { added } = renameWordDiff(pair.oldName, pair.newName);
  const pointsToNew = (word: string) => added.some((newWord) => sameWord(newWord, word));
  if (verdict.verdict === "MISFIT") {
    const caught = typeNameWords(verdict.suggestion).some(pointsToNew);
    return { outcome, score: caught ? "caught" : "flagged-other", mechanisms };
  }
  const catching = alternatives.filter((alternative) => pointsToNew(alternative.word));
  if (catching.length > 0) {
    return { outcome, score: "caught", mechanisms: [...new Set(catching.map(classifyAlternative))] };
  }
  return { outcome, score: "flagged-other", mechanisms };
}

export interface ScoredEvalItem extends ScoredNamingOutcome {
  /** The rename class, or `control`. */
  group: string;
}

export type ScoreCounts = { total: number } & Record<NamingScore, number>;

export interface ScoredItemsTally {
  byGroup: Record<string, ScoreCounts>;
  /** Per mechanism, how often it fired under each score. */
  byMechanism: Record<string, Partial<Record<NamingScore, number>>>;
}

export function tallyScoredItems(items: readonly ScoredEvalItem[]): ScoredItemsTally {
  const byGroup: Record<string, ScoreCounts> = {};
  const byMechanism: Record<string, Partial<Record<NamingScore, number>>> = {};
  for (const item of items) {
    const counts = (byGroup[item.group] ??= {
      total: 0,
      caught: 0,
      "flagged-other": 0,
      silent: 0,
      "false-flag": 0,
      clean: 0,
    });
    counts.total += 1;
    counts[item.score] += 1;
    for (const mechanism of item.mechanisms) {
      const row = (byMechanism[mechanism] ??= {});
      row[item.score] = (row[item.score] ?? 0) + 1;
    }
  }
  return { byGroup, byMechanism };
}

export interface DeprecatedTerm {
  word: string;
  slot: "head" | "qualifier";
  count: number;
  /** The words introduced in the same slot, with counts. */
  replacedBy: Record<string, number>;
}

/**
 * The head / qualifier words the project renamed AWAY from: an old word gone
 * from the new name, counted per slot it held in the old name, with the words
 * the rename introduced in that slot. Most-renamed first, heads before
 * qualifiers, then alphabetical.
 */
export function deprecatedTerms(pairs: readonly RenamePair[]): DeprecatedTerm[] {
  const terms = new Map<string, DeprecatedTerm>();
  for (const pair of pairs) {
    const { oldWords, newWords, removed, added } = renameWordDiff(pair.oldName, pair.newName);
    const oldHead = oldWords.at(-1);
    const newHead = newWords.at(-1);
    for (const word of removed) {
      const slot = word === oldHead ? "head" : "qualifier";
      const replacements =
        slot === "head"
          ? added.filter((addedWord) => addedWord === newHead)
          : added.filter((addedWord) => addedWord !== newHead);
      const term = terms.get(`${slot}:${word}`) ?? { word, slot, count: 0, replacedBy: {} };
      term.count += 1;
      for (const replacement of replacements) term.replacedBy[replacement] = (term.replacedBy[replacement] ?? 0) + 1;
      terms.set(`${slot}:${word}`, term);
    }
  }
  return [...terms.values()].sort(
    (a, b) => b.count - a.count || (a.slot === b.slot ? 0 : a.slot === "head" ? -1 : 1) || a.word.localeCompare(b.word),
  );
}

/**
 * `count` names drawn by a seeded Fisher–Yates over the SORTED pool, returned
 * sorted: the draw depends on the seed and the pool's contents, never on the
 * order the caller enumerated them in.
 */
export function sampleControlTypes(candidates: readonly string[], count: number, seed: number): string[] {
  const pool = [...new Set(candidates)].sort();
  if (pool.length <= count) return pool;
  const random = mulberry32(seed);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count).sort();
}
