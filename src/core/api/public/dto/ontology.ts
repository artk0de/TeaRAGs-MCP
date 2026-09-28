/**
 * Naming ontology audit DTOs — `get_ontology_report` (bd tea-rags-mcp-4p3sb.20).
 *
 * A project-wide audit of how declared values are named against their types,
 * read from the codegraph's `cg_identifiers`. Four ranked, bounded sections:
 *
 * - `synonyms` — one TYPE, many names: a (type, kind) group whose names scatter;
 * - `homonyms` — one NAME, many types: a name bound to two or more concept
 *   types with non-trivial support each;
 * - `outliers` — a name whose naming shape departs from its type's dominant
 *   convention (`tad` beside 40× `tax_automation_document`);
 * - `collisions` — a declared name that equals an existing symbol's short name
 *   where that is ambiguous (see {@link OntologyCollisionRule}).
 *
 * Opt-in `verbs` (spec 2026-09-28 naming coverage, §D5): method names, not
 * values — per noun tail, the verbs the project uses and the names off the
 * dominant one ({@link OntologyVerbGroup}).
 *
 * Evidence is a row whose EFFECTIVE type is a concept type: persisted
 * (`annotation`, `constructor`, `binding`, `finder`, …) or `call-return`, each
 * counted per source in `evidence`. `name-inferred` types never count — the
 * report must not confirm the convention it measures. Generic names (bound to
 * many unrelated types project-wide) are filtered out and listed in the
 * summary.
 *
 * Reserved: a fifth section `conceptSynonyms` — two differently named TYPES
 * that denote one concept — will be fed by concept clustering
 * (bd tea-rags-mcp-wa6bz). It is absent today; the response never carries the
 * key, empty or otherwise.
 */

import type {
  IdentifierDeclarationKind,
  IdentifierTypeSource,
  OntologyCollisionRule,
} from "../../../contracts/types/codegraph.js";

export type { OntologyCollisionRule } from "../../../contracts/types/codegraph.js";

/** A section of the ontology report; `verbs` is opt-in — computed only when `sections` names it. */
export type OntologyReportSectionName = "synonyms" | "homonyms" | "outliers" | "collisions" | "verbs";

/** How a name relates to its type (see the naming lexicon's shape classifier). */
export type OntologyNamingShape = "EXACT" | "QUALIFIED" | "TAIL" | "VERB_TYPE" | "CALLEE_DERIVED" | "FREE";

/** A value kind judged by the report — `return` rows name methods, not values, and are not judged. */
export type OntologyValueKind = Exclude<IdentifierDeclarationKind, "return">;

export interface GetOntologyReportRequest {
  /** Project alias from the collection registry — RECOMMENDED. */
  project?: string;
  /** Explicit Qdrant collection name — highest priority. */
  collection?: string;
  /** Filesystem path to the indexed codebase — backward-compat fallback. */
  path?: string;
  /**
   * Glob scoping the audit. Its literal prefix (up to the first glob
   * metacharacter) filters `rel_path`; the generic-name filter stays
   * project-wide.
   */
  pathPattern?: string;
  /** Restrict to one language's files; its non-concept types and casing apply. */
  language?: string;
  /** Sections to compute (default: synonyms, homonyms, outliers, collisions; `verbs` only when named). */
  sections?: OntologyReportSectionName[];
  /** Items per section (default 20, max 100). Collisions: per rule. */
  limit?: number;
}

/** One example row of a finding. */
export interface OntologyLocation {
  relPath: string;
  line: number;
  /** The symbol declaring the name. */
  symbolId: string;
}

/** Rows behind a finding per effective type source; `untyped` only for `shadowsMethod`. */
export type OntologyEvidence = Partial<Record<IdentifierTypeSource | "untyped", number>>;

/** One name of a synonym group or an outlier's dominant name. */
export interface OntologyNameCount {
  name: string;
  n: number;
  shape: OntologyNamingShape;
  example: OntologyLocation;
}

export interface OntologySynonym {
  type: string;
  kind: OntologyValueKind;
  /** `many` for a group of collections of `type` (`Doc[]`, `list[Doc]`); absent for single values. */
  typeMultiplicity?: "many";
  /** Rows of the group. */
  n: number;
  /** `min(1, (n/20)^2)`. */
  confidence: number;
  /** Share of the group's rows its dominant name holds, singular and plural merged. */
  dominantShare: number;
  /** Normalised Shannon entropy (0..1) of the raw name distribution. */
  entropy: number;
  distinctNames: number;
  dominant: OntologyNameCount;
  /** The next most frequent names, capped per item. */
  deviants: OntologyNameCount[];
  evidence: OntologyEvidence;
}

export interface OntologyHomonym {
  name: string;
  n: number;
  confidence: number;
  /** Share of the name's rows its most frequent type holds. */
  topTypeShare: number;
  types: { type: string; n: number; shape: OntologyNamingShape; example: OntologyLocation }[];
  evidence: OntologyEvidence;
}

export interface OntologyOutlier {
  type: string;
  kind: OntologyValueKind;
  /** `many` when the group is collections of `type`; absent for single values. */
  typeMultiplicity?: "many";
  name: string;
  n: number;
  shape: OntologyNamingShape;
  /** The convention the name departs from: the group's most frequent name in the dominant shape family. */
  dominant: { name: string; n: number; shape: OntologyNamingShape; shapeShare: number };
  /** `min(1, (n/20)^2)` over the group's rows. */
  confidence: number;
  example: OntologyLocation;
  /** Rows of the whole (type, kind) group per type source. */
  evidence: OntologyEvidence;
}

export interface OntologyCollision {
  rule: OntologyCollisionRule;
  name: string;
  /** The collided symbol: a type-like short name, or the shadowed method's symbolId. */
  symbol: string;
  /** The declared type (`namesOtherType` only). */
  type?: string;
  n: number;
  example: OntologyLocation;
  evidence: OntologyEvidence;
}

/** One noun tail and the verbs the project reads it with (`load_user` ×7, `fetch_user` ×1). */
export interface OntologyVerbGroup {
  /** The noun tail, snake-joined. */
  tail: string;
  /** The language namespace's languages present in the group, sorted, comma-joined. */
  language: string;
  /** Method symbols holding a name of the group. */
  holders: number;
  verbs: { verb: string; holders: number }[];
  /** Names off the tail's dominant verb, each with the name the lexicon would suggest. */
  deviants: { name: string; holders: number; suggestion: string }[];
}

export interface OntologyReportSummary {
  /** Concept-typed, non-generic rows of the scope — what every section draws from. */
  evidenceRows: number;
  genericNameCount: number;
  /** The most frequent generic names the filter removed. */
  genericNames: { name: string; typeCount: number; n: number }[];
}

export interface GetOntologyReportResponse {
  /** The literal rel_path prefix used ("" = whole project) and the language filter. */
  scope: { pathPrefix: string; language?: string };
  summary: OntologyReportSummary;
  synonyms?: OntologySynonym[];
  homonyms?: OntologyHomonym[];
  outliers?: OntologyOutlier[];
  collisions?: OntologyCollision[];
  /** Opt-in: per language namespace and noun tail, the verbs and the names off the dominant one. */
  verbs?: OntologyVerbGroup[];
  /** Why sections are empty for a reason other than the data — e.g. the codegraph store could not be opened. */
  notices?: string[];
  /** Set when the index predates `cg_identifiers` (migration 033) — reindex, the report is not "clean". */
  driftWarning?: string;
}
