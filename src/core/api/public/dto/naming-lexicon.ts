/**
 * Naming-lexicon DTOs — request / response of the `get_naming_lexicon` tool
 * (bd tea-rags-mcp-4p3sb.11): how THIS project names values of a type, values
 * bound to a call, and a concept, plus a verdict per draft name — value names
 * and, with `kind: "type"`, type and constant names (bd tea-rags-mcp-vi0wx).
 */

import type {
  IdentifierBoundCallee,
  IdentifierDeclarationKind,
  IdentifierTypeSource,
} from "../../../contracts/types/codegraph-extraction.js";
import type { SymbolDefinitionKind } from "../../../contracts/types/codegraph-symbols.js";
import type {
  ConceptTerm,
  NamingShapeShare,
  NamingVerdict,
  TypeNameHeadCarriers,
} from "../../../domains/explore/naming-lexicon/index.js";
import type { CollectionRef } from "./explore.js";

/**
 * A name the caller is about to write, with whatever it knows about it. A value
 * name (`kind` absent or a declaration kind) uses `type` / `typeMultiplicity` /
 * `callee`; a type or constant name (`kind: "type"`) uses `path` (required),
 * `extends`, `concept` and `symbolKind` — see {@link NamingLexiconTypeDraft}.
 */
export interface NamingLexiconDraftName {
  name: string;
  /** Defaults to `local`; `type` = a type or constant declaration. */
  kind?: IdentifierDeclarationKind | "type";
  type?: string;
  /**
   * `many` when the value is a collection of `type` (`Item[]`, `list[Item]`):
   * judged against the collection rows of `type` only, and a name spelling the
   * type must agree in number with them. `type` is the ELEMENT type. Defaults to `one`.
   */
  typeMultiplicity?: "one" | "many";
  /** The call the value is bound to — drives `byCallee` when `type` is absent. */
  callee?: IdentifierBoundCallee;
  /** `kind: "type"`: the file the declaration will live in — its directory's role and its language's casing. */
  path?: string;
  /** `kind: "type"`: the planned ancestor — its family's role. Ignored for a constant. */
  extends?: string;
  /** `kind: "type"`: the meaning, for term alignment; absent → the request's `concept`, else the name's own words. */
  concept?: string;
  /**
   * `kind: "type"`: the declaration kind, when known (diff mode knows it). A
   * `constant` is judged against the project's constants; absent → a
   * SCREAMING_SNAKE name is a constant, any other a type.
   */
  symbolKind?: SymbolDefinitionKind;
}

/** A type or constant draft (`kind: "type"`), as the ops layer judges it once `path` is validated. */
export type NamingLexiconTypeDraft = Omit<NamingLexiconDraftName, "kind" | "path"> & { kind: "type"; path: string };

/**
 * The evidence scope of one answer — internal, not a request field: diff mode
 * (bd tea-rags-mcp-fdef2) passes the changed files, and EVERY evidence read
 * skips them (spec §6.4), so a change an incremental reindex already stored
 * cannot vote for itself.
 */
export interface NamingLexiconEvidenceScope {
  excludePaths?: readonly string[];
}

/**
 * At least one of `types` / `anchors` / `concept` / `names` / `changes` /
 * `files`; `concept` requires `language`. `changes` and `files` (diff mode, bd
 * tea-rags-mcp-fdef2) need the project's working tree — a `project` or `path`.
 */
export interface NamingLexiconRequest extends CollectionRef {
  /** Glob; its literal prefix (before the first `*?{[`) scopes the rows read. */
  pathPattern?: string;
  /** Casing and non-concept types come from this language's descriptor; absent → the scope's dominant language. */
  language?: string;
  types?: string[];
  /** SymbolIds whose typed params / return add their types to `types`. */
  anchors?: string[];
  concept?: string;
  names?: NamingLexiconDraftName[];
  /**
   * Diff mode: review the declarations the working tree ADDS against `base`
   * (default `HEAD` — uncommitted work, untracked files included). `base` is
   * resolved to its merge-base with HEAD (`git merge-base <base> HEAD`), so a
   * branch diff holds only the branch's side — what `git diff <base>...HEAD`
   * shows, plus uncommitted work — however far the base moved on since. A
   * commit HEAD descends from is its own merge-base, so passing one pins the
   * comparison exactly. The answer carries `review`.
   */
  changes?: { base?: string };
  /**
   * Diff mode over these files only, against `changes.base` resolved the same
   * way (default `HEAD`): a file with a diff is reviewed by its added lines, an
   * untracked one whole, and one with no diff whole too — every declaration it
   * holds (`review.wholeFiles` counts them).
   */
  files?: string[];
}

/** Where a row's type came from: a persisted source, the query-time `call-return` join, or the `name-inferred` statistic. */
export type NamingLexiconEvidenceSource = IdentifierTypeSource | "name-inferred";

/** One observed name with its row count. */
export interface NamingLexiconNameCount {
  name: string;
  n: number;
}

/** Names per kind (top 5, most frequent first) and the shape shares of each kind. */
export interface NamingLexiconKindProfile {
  kinds: Partial<Record<IdentifierDeclarationKind, NamingLexiconNameCount[]>>;
  shapes: Partial<Record<IdentifierDeclarationKind, NamingShapeShare[]>>;
}

/** How the project names values of one type. */
export interface NamingLexiconTypeEntry extends NamingLexiconKindProfile {
  type: string;
  /** `min(1, (n / 20) ** 2)` over every row of the type. */
  confidence: number;
  /** Row counts per type source — how much of the answer rests on each recovery stage. */
  evidence: Partial<Record<NamingLexiconEvidenceSource, number>>;
}

/** How the project names values bound to one callee (a draft's `callee`, untyped path). */
export interface NamingLexiconCalleeEntry extends NamingLexiconKindProfile {
  member: string;
  receiver?: string;
}

/**
 * Evidence behind one draft-name verdict. A draft's own declaration is never
 * its evidence (bd tea-rags-mcp-xsxkr): a type draft's own declaration at its
 * `path` is left out of every count, and a value draft given a `path` is judged
 * with that file left out of every read — as diff mode leaves out the changed
 * files.
 */
export interface NamingLexiconNameEvidence {
  /** Rows already carrying this name, project-wide — its own declaration excluded. */
  n: number;
  /** An owner symbol holding the suggested / observed name. */
  example?: string;
  /** Distinct types this name is bound to (homonymy). */
  boundTypes: number;
  /** The name is already a symbol's short name — of a symbol other than the draft's own. */
  collision: boolean;
  /**
   * A value / return draft's `collision`: the symbols it collides with, at most
   * three ids (an override of `AbstractPolicy#same_firm?` reads as such). Absent
   * when there is no collision, in diff mode, or without a symbol lookup.
   */
  collisions?: string[];
}

/**
 * The caveat on a draft named with a name `get_ontology_report` judges GENERIC
 * in the answer's scope (`result`, `data`): bound to many types it does not
 * spell, none of them dominant — so a verdict, CONFORMS included, says nothing
 * about what the name tells a reader. Same judgement, same numbers as the
 * report's `summary.genericNames` entry.
 */
export interface NamingLexiconGenericName {
  /** Types the name is bound to that it does not spell. */
  typeCount: number;
  /** Rows behind those types. */
  n: number;
}

/**
 * A verdict on one draft name; `genericName` only when the name is judged
 * generic in scope.
 *
 * CONFORMS means consistent with the project's vocabulary — its words, roles
 * and spellings. It says nothing about whether the name fits the behaviour of
 * the code it names: that is the reviewer's judgement, not the lexicon's.
 *
 * `alternatives` ride on NEW_TERM, and on a type draft's CONFORMS when only a
 * project suffix or known words confirmed it and the project spells one of its
 * words with another, similar word (`EmbeddingBackend` → `provider`,
 * `IndexStalenessChecker` → `freshness` for `staleness`; bd
 * tea-rags-mcp-433d2). Never on MISFIT, and never on a name carrying its
 * expected family / directory role.
 */
export type NamingLexiconNameVerdict = {
  name: string;
  /**
   * A type draft judged in a language other than the answer's `language` — its
   * path's (bd tea-rags-mcp-icuxg). Absent: judged in the answer's language.
   */
  language?: string;
  evidence: NamingLexiconNameEvidence;
  genericName?: NamingLexiconGenericName;
} & NamingVerdict;

/**
 * One reviewed declaration that did not simply conform: a verdict other than
 * CONFORMS, or a CONFORMS on a name judged generic (`genericName`) or carrying
 * head `alternatives`.
 */
export type NamingReviewFinding = {
  relPath: string;
  /** 1-based line of the declared name. */
  line: number;
  name: string;
  /** A value's declaration kind (`param`, `local`, `field`, `return`) or a type's symbol kind (`class`, `constant`, …). */
  kind: string;
  /** A value's declared type, when it has one. */
  type?: string;
  genericName?: NamingLexiconGenericName;
} & NamingVerdict;

/**
 * Why a diff-mode declaration or file was not judged: `unknownReturnType` — a
 * method / function whose return type is unknown, so no draft carries its
 * name; `nonProduction` — a test / script / fixture file; `noCodegraphLanguage`
 * — no codegraph language walks the extension; `unreadable` — the file is gone
 * from the working tree or failed to parse.
 */
export type NamingReviewNotJudgedReason = "unknownReturnType" | "nonProduction" | "noCodegraphLanguage" | "unreadable";

/** One thing diff mode did not judge; a file carries no `line` / `name`. */
export interface NamingReviewNotJudgedEntry {
  relPath: string;
  line?: number;
  name?: string;
  /** `file`, or the declaration's kind (`method`, `function`). */
  kind: string;
  reason: NamingReviewNotJudgedReason;
}

/** The naming review of a diff (`changes` / `files`, bd tea-rags-mcp-fdef2). */
export interface NamingReviewResult {
  /** The ref the request named (`HEAD` when none). */
  base: string;
  /** The commit the change was read against: `base`'s merge-base with HEAD. */
  mergeBase: string;
  /**
   * Files that differ from what the change was read against, untracked ones
   * included, before the cap; with `files`, those of the listed ones.
   */
  changedFiles: number;
  /**
   * Of `files`, the listed ones with no diff against the base: reviewed whole,
   * every declaration they hold — not only added ones. Absent when none.
   */
  wholeFiles?: number;
  /**
   * Declarations judged: the added ones, in production files a codegraph
   * language walks. `checked = conforming + novel + findings.length`.
   */
  checked: number;
  /** Of `checked`, CONFORMS on a name that is not generic and carries no `alternatives` — not listed. */
  conforming: number;
  /**
   * Of `checked`, NEW_TERM with no `topTerms` and no `alternatives` on a name
   * that is not generic: the project has nothing to compare it with, so there
   * is nothing to act on — not listed.
   */
  novel: number;
  /** Everything else: a verdict to act on, or a generic name (`genericName`). */
  findings: NamingReviewFinding[];
  /**
   * Changed files with added lines whose declarations were not judged: a
   * non-production file (tests, scripts, fixtures — the masks the evidence side
   * excludes), no codegraph language walks the extension, or the file is gone
   * from the working tree or failed to parse. Their declarations are not in
   * `checked`.
   */
  notJudged: number;
  /**
   * What the review did not judge, per kind (`file`, `method`, `function`) and
   * reason, counted whole: the files behind `notJudged`, and the methods /
   * functions on added lines with no known return type — a method name is
   * judged only through its return type, so these are in neither `checked`
   * nor `conforming`. Absent when everything was judged.
   */
  notJudgedBy?: Partial<Record<string, Partial<Record<NamingReviewNotJudgedReason, number>>>>;
  /** The first 50 of `notJudgedBy`, in path and line order — what a reviewer still has to read. */
  notJudgedNames?: NamingReviewNotJudgedEntry[];
  /** Set when more files changed than one call reviews (200): the files past the cap, in path order, are skipped. */
  truncated?: { cap: number; skipped: number };
}

/**
 * The type declarations one single-word `types` entry heads — their names END in
 * it (`…Helper`), namespace modules excluded (bd tea-rags-mcp-i569j).
 */
export type NamingLexiconTypeNameHead = TypeNameHeadCarriers;

export interface NamingLexiconResult {
  /** The rel_path prefix actually read — after widening; `""` = the whole project. */
  scope: string;
  /**
   * The language the answer is written in, when one was known: the request's;
   * else the `pathPattern`'s; else the one the evidence rows of the asked types
   * and callees come from; else the one most type drafts' paths are written in;
   * else the project's dominant one. Its descriptor supplies the value drafts'
   * casing and the non-concept types. A type draft is judged in its own path's
   * language regardless, and names it (`names[].language`) when it differs.
   */
  language?: string;
  byType: NamingLexiconTypeEntry[];
  /**
   * Set when `types` holds a single-word entry: the type declarations under the
   * REQUESTED pattern's literal prefix (`scope`, never widened; `""` = the whole
   * project) whose names that word heads — the suffix vocabulary `byType`'s
   * value rows cannot show (`Helper`: 151 declarations, no value typed as one).
   */
  typeNameHeads?: { scope: string; heads: NamingLexiconTypeNameHead[] };
  byCallee?: NamingLexiconCalleeEntry[];
  concept?: { terms: ConceptTerm[] };
  names: NamingLexiconNameVerdict[];
  /** e.g. `concept step skipped: …` when embeddings are unavailable, or an empty type-declaration table. */
  notices?: string[];
  /** Set when the index predates the identifier table — names the reindex. */
  driftWarning?: string;
  /** Diff mode's answer, when the request carried `changes` or `files`. */
  review?: NamingReviewResult;
}
