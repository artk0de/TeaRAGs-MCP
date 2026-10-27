/**
 * `locate` spike — pure ranking: seed fusion, identifier extraction, sibling
 * classification and the per-file merge. No I/O; the tool module feeds it
 * search / graph rows.
 */

/** One search row as `locate` reads it (payload cut to what the merge needs). */
export interface LocateRow {
  relativePath: string;
  symbolId?: string;
  content?: string;
  startLine?: number;
}

export interface LocateSeed extends LocateRow {
  /** Normalized symbol id (trailing `#partN` stripped) or `relativePath:startLine` when absent. */
  key: string;
  rrf: number;
  rank: number;
}

export interface LocateSiblingHit {
  identifier: string;
  relation: "definesSame" | "sharesIdentifier";
  row: LocateRow;
}

export interface LocateCallerHit {
  seedSymbol: string;
  relativePath: string;
  symbolId: string;
  callExpression: string;
}

/**
 * One file-level graph edge walked outward from an already-found file:
 * `importedBy` = `relativePath` depends on `fromFile` (file-scope get_callers),
 * `imports` = `fromFile` depends on `relativePath` (file-scope get_callees).
 */
export interface LocateStructuralHit {
  relativePath: string;
  fromFile: string;
  hop: 1 | 2;
  direction: "importedBy" | "imports";
  /** 0..1 — how selective the edge list was (1 for a short list, small for a hub's). */
  selectivity: number;
}

export interface LocateFile {
  relativePath: string;
  score: number;
  symbol?: string;
  via: string[];
  line: string;
}

const RRF_K = 60;
const MAX_LINE_CHARS = 80;
const SEED_WEIGHT = 1.0;
const SEED_FILE_CAP = 2.0;
const DEFINES_SAME_WEIGHT = 1.0;
const SHARES_IDENTIFIER_WEIGHT = 0.4;
const SHARES_IDENTIFIER_CAP = 1.2;
const CALLER_WEIGHT = 0.6;
const CALLER_CAP = 1.8;
const DEFINING_NAME_BONUS = 1.5;
const METHOD_PIVOT_BONUS = 3;
const NON_SELECTIVE_WEIGHT = 0.1;
const HOP1_WEIGHT = 0.9;
const HOP2_WEIGHT = 0.5;
const STRUCTURAL_CAP = 1.8;
const CONVERGENCE_BONUS = 0.6;
/** Edge lists at or under this length count as fully selective. */
const SELECTIVE_EDGE_COUNT = 10;

/** Selectivity of one file-level edge list: 1 up to `SELECTIVE_EDGE_COUNT` edges, decaying as 10/total beyond. */
export function edgeSelectivity(total: number): number {
  return total <= SELECTIVE_EDGE_COUNT ? 1 : SELECTIVE_EDGE_COUNT / total;
}

/**
 * Hop-2 expansion sources among hop-1 neighbours: a neighbour that already
 * scored through another relation (`scored`) or that 2+ distinct found files
 * reach ranks first, then by summed selectivity. Hop-1 sources themselves are
 * never re-expanded.
 */
export function selectHop2Sources(
  hop1: readonly LocateStructuralHit[],
  options: { scored: ReadonlySet<string>; exclude: ReadonlySet<string>; max: number; isTest?: (p: string) => boolean },
): string[] {
  const isTest = options.isTest ?? isTestPath;
  const stats = new Map<string, { from: Set<string>; selectivity: number }>();
  for (const hit of hop1) {
    if (options.exclude.has(hit.relativePath) || isTest(hit.relativePath)) continue;
    let entry = stats.get(hit.relativePath);
    if (!entry) stats.set(hit.relativePath, (entry = { from: new Set(), selectivity: 0 }));
    entry.from.add(hit.fromFile);
    entry.selectivity += hit.selectivity;
  }
  const priority = (path: string, entry: { from: Set<string> }): number =>
    (options.scored.has(path) ? 1 : 0) + (entry.from.size >= 2 ? 1 : 0);
  return [...stats.entries()]
    .sort(
      (a, b) =>
        priority(b[0], b[1]) - priority(a[0], a[1]) || b[1].selectivity - a[1].selectivity || a[0].localeCompare(b[0]),
    )
    .slice(0, options.max)
    .map(([path]) => path);
}

/** Structural score of one file: hop-weighted selectivity per distinct source file, capped, plus convergence. */
export function structuralScore(hits: readonly LocateStructuralHit[]): number {
  const bySource = new Map<string, number>();
  for (const hit of hits) {
    const weight = (hit.hop === 1 ? HOP1_WEIGHT : HOP2_WEIGHT) * hit.selectivity;
    bySource.set(hit.fromFile, Math.max(bySource.get(hit.fromFile) ?? 0, weight));
  }
  const sum = [...bySource.values()].reduce((a, b) => a + b, 0);
  return Math.min(sum, STRUCTURAL_CAP) + (bySource.size >= 2 ? CONVERGENCE_BONUS : 0);
}

/**
 * Diminishing returns per evidence source: the k-th distinct target a source
 * reaches (in arrival order) weighs 1/k. Keyed `${source}\0${target}`. One
 * broad source — a helper every serializer calls, a module every file
 * imports — then cannot fill the answer's tail on its own.
 */
export function diminishingReturns(pairs: readonly (readonly [string, string])[]): Map<string, number> {
  const ordinals = new Map<string, number>();
  const out = new Map<string, number>();
  for (const [source, target] of pairs) {
    const key = `${source}\0${target}`;
    if (out.has(key)) continue;
    const k = (ordinals.get(source) ?? 0) + 1;
    ordinals.set(source, k);
    out.set(key, 1 / k);
  }
  return out;
}

const PATH_DIVERSITY = 0.4;

/** Directory similarity: shared leading directory segments over the longer directory depth (0..1). */
export function directorySimilarity(a: string, b: string): number {
  const da = parentDirectory(a).split("/").filter(Boolean);
  const db = parentDirectory(b).split("/").filter(Boolean);
  const depth = Math.max(da.length, db.length);
  if (depth === 0) return 1;
  let shared = 0;
  while (shared < Math.min(da.length, db.length) && da[shared] === db[shared]) shared++;
  return shared / depth;
}

/**
 * Greedy MMR over the score-sorted list: each pick maximises
 * `score × (1 − λ × max directory similarity to the files already picked)`.
 * A module that floods the candidates keeps its best files but stops
 * crowding the other modules a change also touches out of the top N.
 */
export function diversifyByPath<T extends { relativePath: string; score: number }>(
  ranked: readonly T[],
  max: number,
  lambda: number,
): T[] {
  if (lambda <= 0) return ranked.slice(0, max);
  const pool = [...ranked];
  const picked: T[] = [];
  while (picked.length < max && pool.length > 0) {
    let best = 0;
    let bestValue = Number.NEGATIVE_INFINITY;
    pool.forEach((candidate, index) => {
      const sim = picked.reduce((m, p) => Math.max(m, directorySimilarity(candidate.relativePath, p.relativePath)), 0);
      const value = candidate.score * (1 - lambda * sim);
      if (value > bestValue) {
        bestValue = value;
        best = index;
      }
    });
    picked.push(...pool.splice(best, 1));
  }
  return picked;
}

function baseName(relativePath: string): string {
  return relativePath.slice(relativePath.lastIndexOf("/") + 1);
}

/** `Foo#bar#part2` → `Foo#bar`. */
export function normalizeSymbolId(symbolId: string): string {
  return symbolId.replace(/#part\d+$/, "");
}

/** Last name segment of a symbol id: `A::B#run` → `run`, `Foo.bar` → `bar`. */
export function symbolLastSegment(symbolId: string): string {
  const parts = normalizeSymbolId(symbolId).split(/::|[#.]/);
  return parts[parts.length - 1] ?? symbolId;
}

export function isTestPath(relativePath: string): boolean {
  return (
    /(^|\/)(spec|test|tests|__tests__)\//.test(relativePath) || /(_spec\.|\.test\.|\.spec\.|_test\.)/.test(relativePath)
  );
}

/** Union seed lists by normalized symbol id, ranked by reciprocal-rank fusion. */
export function rankSeeds(lists: readonly (readonly LocateRow[])[]): LocateSeed[] {
  const byKey = new Map<string, { row: LocateRow; rrf: number }>();
  for (const list of lists) {
    list.forEach((row, index) => {
      const key = row.symbolId ? normalizeSymbolId(row.symbolId) : `${row.relativePath}:${row.startLine ?? 0}`;
      const contribution = 1 / (RRF_K + index + 1);
      const existing = byKey.get(key);
      if (existing) {
        existing.rrf += contribution;
        if (!existing.row.content && row.content) existing.row = row;
      } else {
        byKey.set(key, { row, rrf: contribution });
      }
    });
  }
  return [...byKey.entries()]
    .sort((a, b) => b[1].rrf - a[1].rrf)
    .map(([key, { row, rrf }], index) => ({ ...row, key, rrf, rank: index + 1 }));
}

/** Parent directory of a repo-relative path (`""` at the root). */
export function parentDirectory(relativePath: string): string {
  const slash = relativePath.lastIndexOf("/");
  return slash < 0 ? "" : relativePath.slice(0, slash);
}

/**
 * First `max` non-test paths of a ranked list, at most `perDir` per parent
 * directory — expansion sources spread over modules instead of one facet.
 */
export function topFilesPerDirectory(ranked: readonly string[], max: number, perDir: number): string[] {
  const dirCount = new Map<string, number>();
  const out: string[] = [];
  for (const path of ranked) {
    if (out.length >= max) break;
    if (isTestPath(path)) continue;
    const dir = parentDirectory(path);
    const inDir = dirCount.get(dir) ?? 0;
    if (inDir >= perDir) continue;
    dirCount.set(dir, inDir + 1);
    out.push(path);
  }
  return out;
}

const IDENTIFIER_PATTERNS: readonly RegExp[] = [
  /\b[A-Z][A-Za-z0-9]*(?:::[A-Z][A-Za-z0-9]*)+/g, // A::B constants
  /\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+\b/g, // CamelCase, ≥2 humps
  /\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]+)+\b/g, // lowerCamel, ≥2 humps
  /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+[?!]?/g, // snake_case, ≥2 parts
  /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g, // SCREAMING_SNAKE, ≥2 parts
];

const IDENTIFIER_STOPLIST = new Set([
  // Ruby / Rails
  "attr_accessor",
  "attr_reader",
  "attr_writer",
  "before_action",
  "after_action",
  "skip_before_action",
  "respond_to",
  "has_many",
  "has_one",
  "belongs_to",
  "validates_presence_of",
  "each_with_object",
  "each_with_index",
  "define_method",
  "instance_variable_get",
  "instance_variable_set",
  "send_data",
  "to_sym",
  "to_json",
  "as_json",
  "present?",
  "blank?",
  "is_a?",
  "nil?",
  "respond_to?",
  "ActiveRecord::Base",
  "ActiveSupport::Concern",
  "ActiveSupport::TimeWithZone",
  "StandardError",
  "ArgumentError",
  "NoMethodError",
  "RuntimeError",
  "ApplicationRecord",
  "ApplicationController",
  // JS / TS
  "toString",
  "forEach",
  "indexOf",
  "toLowerCase",
  "toUpperCase",
  "hasOwnProperty",
  "readonly",
  "ReadonlyArray",
  "Promise",
  "PromiseLike",
  "Record",
  "ReturnType",
  "Partial",
  "Required",
  "NonNullable",
  "JSON",
  "TypeError",
  "RangeError",
  "localeCompare",
  "startsWith",
  "endsWith",
  "flatMap",
  "fromEntries",
  "isArray",
  "toFixed",
  "padStart",
  "setTimeout",
  "clearTimeout",
  "typeof",
  "instanceof",
  "keyof",
  // Python
  "__init__",
  "__name__",
  "self_",
]);

/** Project-specific identifier tokens in one text (deduplicated, stoplist dropped). */
export function identifierTokens(text: string): Set<string> {
  const found = new Set<string>();
  for (const pattern of IDENTIFIER_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const token = match[0];
      if (token.length < 5 || IDENTIFIER_STOPLIST.has(token)) continue;
      found.add(token);
    }
  }
  return found;
}

/**
 * Identifiers from the top seeds' contents, scored by the number of distinct
 * seeds carrying them plus a bonus when a seed DEFINES the name.
 */
export function extractIdentifiers(
  seeds: readonly LocateSeed[],
  options: { topSeeds?: number; keep?: number } = {},
): string[] {
  return selectIdentifiers(seeds, options).identifiers;
}

/** `A::B::C#run` → owner/namespace segments `A`, `B` and their `::` prefixes `A`, `A::B`. */
export function namespaceSegments(symbolId: string): string[] {
  const parts = normalizeSymbolId(symbolId).split("::");
  const out: string[] = [];
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (part) out.push(part);
    out.push(parts.slice(0, i + 1).join("::"));
  }
  return out;
}

/** Method name a seed defines: last segment when the id carries a `#` / `.` member separator. */
export function methodPivotName(symbolId: string): string | undefined {
  const tail = normalizeSymbolId(symbolId).split("::").pop() ?? "";
  return /[#.]/.test(tail) ? symbolLastSegment(symbolId) : undefined;
}

/**
 * Identifier selection: tokens from the top seeds scored by distinct-seed
 * count; seed-defined METHOD names (parallel-implementation pivots) get the
 * largest bonus; namespace/owner segments of any seed symbolId are dropped.
 */
export function selectIdentifiers(
  seeds: readonly LocateSeed[],
  options: { topSeeds?: number; keep?: number } = {},
): { identifiers: string[]; pivots: Set<string> } {
  const top = seeds.slice(0, options.topSeeds ?? 6);
  const keep = options.keep ?? 8;
  const namespaces = new Set(seeds.flatMap((seed) => (seed.symbolId ? namespaceSegments(seed.symbolId) : [])));
  const pivots = new Set<string>();
  const scores = new Map<string, number>();
  const usable = (name: string): boolean =>
    name.length >= 5 && !IDENTIFIER_STOPLIST.has(name) && !namespaces.has(name) && identifierTokens(name).size > 0;
  for (const seed of top) {
    for (const token of identifierTokens(seed.content ?? "")) {
      if (namespaces.has(token)) continue;
      scores.set(token, (scores.get(token) ?? 0) + 1);
    }
  }
  for (const seed of top) {
    if (!seed.symbolId) continue;
    const name = symbolLastSegment(seed.symbolId);
    if (!usable(name)) continue;
    const isMethod = methodPivotName(seed.symbolId) !== undefined;
    if (isMethod) pivots.add(name);
    scores.set(name, (scores.get(name) ?? 0) + (isMethod ? METHOD_PIVOT_BONUS : DEFINING_NAME_BONUS));
  }
  const identifiers = [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]))
    .slice(0, keep)
    .map(([token]) => token);
  return { identifiers, pivots: new Set(identifiers.filter((ident) => pivots.has(ident))) };
}

/**
 * Identifiers whose sibling rows span ≥ `minFiles` distinct files with no
 * `definesSame` hit — too common to localize anything.
 */
export function nonSelectiveIdentifiers(siblings: readonly LocateSiblingHit[], minFiles = 8): Set<string> {
  const files = new Map<string, Set<string>>();
  const defined = new Set<string>();
  for (const hit of siblings) {
    if (hit.relation === "definesSame") defined.add(hit.identifier);
    let set = files.get(hit.identifier);
    if (!set) files.set(hit.identifier, (set = new Set()));
    set.add(hit.row.relativePath);
  }
  return new Set(
    [...files.entries()].filter(([ident, set]) => set.size >= minFiles && !defined.has(ident)).map(([ident]) => ident),
  );
}

/** `A::B::C#run` → `C#run` (last two name segments). */
export function shortSymbolId(symbolId: string): string {
  const pieces = symbolId.split(/(::|#|\.)/);
  return pieces.length <= 3 ? symbolId : pieces.slice(-3).join("");
}

/** Keep the rows of an identifier query that really carry the identifier. */
export function classifySiblingRows(identifier: string, rows: readonly LocateRow[]): LocateSiblingHit[] {
  const hits: LocateSiblingHit[] = [];
  for (const row of rows) {
    if (row.symbolId && symbolLastSegment(row.symbolId) === identifier) {
      hits.push({ identifier, relation: "definesSame", row });
    } else if ((row.content ?? "").includes(identifier) || (row.symbolId ?? "").includes(identifier)) {
      hits.push({ identifier, relation: "sharesIdentifier", row });
    }
  }
  return hits;
}

/** First line of `content` naming any of `needles`, else its first non-blank line. */
export function representativeLine(content: string | undefined, needles: readonly string[]): string {
  if (!content) return "";
  const lines = content.split("\n");
  const hit = lines.find((line) => needles.some((needle) => needle.length > 0 && line.includes(needle)));
  const chosen = (hit ?? lines.find((line) => line.trim().length > 0) ?? "").trim();
  return chosen.length > MAX_LINE_CHARS ? `${chosen.slice(0, MAX_LINE_CHARS - 1)}…` : chosen;
}

interface FileAccumulator {
  relativePath: string;
  seedScore: number;
  definesSame: Set<string>;
  sharesIdentifier: Set<string>;
  callers: Map<string, number>;
  structural: LocateStructuralHit[];
  symbols: string[];
  via: string[];
  line: string;
  lineRank: number;
}

function pushUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

/** Merge every hit per relativePath and rank the files. */
export function mergeLocateFiles(input: {
  seeds: readonly LocateSeed[];
  siblings: readonly LocateSiblingHit[];
  callers: readonly LocateCallerHit[];
  structural?: readonly LocateStructuralHit[];
  /** MMR λ over directory similarity; 0 = plain score order. */
  pathDiversity?: number;
  identifiers: readonly string[];
  maxFiles: number;
  excludeTests?: boolean;
  nonSelective?: ReadonlySet<string>;
}): { files: LocateFile[]; truncated: boolean } {
  const nonSelective = input.nonSelective ?? new Set<string>();
  const excludeTests = input.excludeTests ?? true;
  const files = new Map<string, FileAccumulator>();
  const at = (relativePath: string): FileAccumulator | undefined => {
    if (excludeTests && isTestPath(relativePath)) return undefined;
    let acc = files.get(relativePath);
    if (!acc) {
      acc = {
        relativePath,
        seedScore: 0,
        definesSame: new Set(),
        sharesIdentifier: new Set(),
        callers: new Map(),
        structural: [],
        symbols: [],
        via: [],
        line: "",
        lineRank: Number.POSITIVE_INFINITY,
      };
      files.set(relativePath, acc);
    }
    return acc;
  };
  // Line priority: seed (0) < definesSame (1) < caller (2) < sharesIdentifier (3).
  const offerLine = (acc: FileAccumulator, line: string, rank: number): void => {
    if (line && rank < acc.lineRank) {
      acc.line = line;
      acc.lineRank = rank;
    }
  };

  const maxRrf = input.seeds.reduce((max, seed) => Math.max(max, seed.rrf), 0) || 1;
  for (const seed of input.seeds) {
    const acc = at(seed.relativePath);
    if (!acc) continue;
    acc.seedScore += SEED_WEIGHT * (seed.rrf / maxRrf);
    if (seed.symbolId) pushUnique(acc.symbols, normalizeSymbolId(seed.symbolId));
    pushUnique(acc.via, `seed#${seed.rank}`);
    offerLine(acc, representativeLine(seed.content, input.identifiers), 0);
  }
  for (const hit of input.siblings) {
    const acc = at(hit.row.relativePath);
    if (!acc) continue;
    if (hit.relation === "definesSame") acc.definesSame.add(hit.identifier);
    else acc.sharesIdentifier.add(hit.identifier);
    if (hit.row.symbolId) pushUnique(acc.symbols, normalizeSymbolId(hit.row.symbolId));
    if (!nonSelective.has(hit.identifier)) pushUnique(acc.via, `${hit.relation}:${hit.identifier}`);
    offerLine(acc, representativeLine(hit.row.content, [hit.identifier]), hit.relation === "definesSame" ? 1 : 3);
  }
  const callerDamping = diminishingReturns(input.callers.map((c) => [c.seedSymbol, c.relativePath] as const));
  for (const caller of input.callers) {
    const acc = at(caller.relativePath);
    if (!acc) continue;
    const damping = callerDamping.get(`${caller.seedSymbol}\0${caller.relativePath}`) ?? 1;
    acc.callers.set(caller.seedSymbol, Math.max(acc.callers.get(caller.seedSymbol) ?? 0, damping));
    pushUnique(acc.symbols, caller.symbolId);
    pushUnique(acc.via, `calls:${shortSymbolId(caller.seedSymbol)}`);
    offerLine(acc, representativeLine(caller.callExpression, []), 2);
  }
  const structuralHits = (input.structural ?? []).filter((hit) => hit.relativePath !== hit.fromFile);
  const structuralDamping = diminishingReturns(
    structuralHits.map((hit) => [`${hit.fromFile}\0${hit.direction}`, hit.relativePath] as const),
  );
  for (const hit of structuralHits) {
    const acc = at(hit.relativePath);
    if (!acc) continue;
    const damping = structuralDamping.get(`${hit.fromFile}\0${hit.direction}\0${hit.relativePath}`) ?? 1;
    acc.structural.push({ ...hit, selectivity: hit.selectivity * damping });
    pushUnique(acc.via, `${hit.direction}${hit.hop === 2 ? "2" : ""}:${baseName(hit.fromFile)}`);
  }

  const ranked = [...files.values()]
    .map((acc) => {
      const sharesOnly = [...acc.sharesIdentifier].filter((ident) => !acc.definesSame.has(ident));
      const score =
        Math.min(acc.seedScore, SEED_FILE_CAP) +
        DEFINES_SAME_WEIGHT * acc.definesSame.size +
        Math.min(
          sharesOnly.reduce(
            (sum, ident) => sum + (nonSelective.has(ident) ? NON_SELECTIVE_WEIGHT : SHARES_IDENTIFIER_WEIGHT),
            0,
          ),
          SHARES_IDENTIFIER_CAP,
        ) +
        Math.min(CALLER_WEIGHT * [...acc.callers.values()].reduce((a, b) => a + b, 0), CALLER_CAP) +
        structuralScore(acc.structural);
      return {
        relativePath: acc.relativePath,
        score: Math.round(score * 100) / 100,
        ...(acc.symbols[0] !== undefined && { symbol: shortSymbolId(acc.symbols[0]) }),
        via: acc.via.slice(0, 3),
        line: acc.line,
      };
    })
    .sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath));
  return {
    files: diversifyByPath(ranked, input.maxFiles, input.pathDiversity ?? PATH_DIVERSITY),
    truncated: ranked.length > input.maxFiles,
  };
}
