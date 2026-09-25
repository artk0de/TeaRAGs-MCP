/**
 * Naming-lexicon DTOs — request / response of the `get_naming_lexicon` tool
 * (bd tea-rags-mcp-4p3sb.11): how THIS project names values of a type, values
 * bound to a call, and a concept, plus a verdict per draft name.
 */

import type {
  IdentifierBoundCallee,
  IdentifierDeclarationKind,
  IdentifierTypeSource,
} from "../../../contracts/types/codegraph-extraction.js";
import type { ConceptTerm, NamingShapeShare, NamingVerdict } from "../../../domains/explore/naming-lexicon/index.js";
import type { CollectionRef } from "./explore.js";

/** A name the caller is about to write, with whatever it knows about the value. */
export interface NamingLexiconDraftName {
  name: string;
  /** Defaults to `local`. */
  kind?: IdentifierDeclarationKind;
  type?: string;
  /** The call the value is bound to — drives `byCallee` when `type` is absent. */
  callee?: IdentifierBoundCallee;
}

/** At least one of `types` / `anchors` / `concept` / `names`; `concept` requires `language`. */
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

/** Evidence behind one draft-name verdict. */
export interface NamingLexiconNameEvidence {
  /** Rows already carrying this name, project-wide. */
  n: number;
  /** An owner symbol holding the suggested / observed name. */
  example?: string;
  /** Distinct types this name is bound to (homonymy). */
  boundTypes: number;
  /** The name is already a symbol's short name. */
  collision: boolean;
}

/** A verdict on one draft name. */
export type NamingLexiconNameVerdict = { name: string; evidence: NamingLexiconNameEvidence } & NamingVerdict;

export interface NamingLexiconResult {
  /** The rel_path prefix actually read — after widening; `""` = the whole project. */
  scope: string;
  /** The language whose descriptor supplied casing and non-concept types, when one was known. */
  language?: string;
  byType: NamingLexiconTypeEntry[];
  byCallee?: NamingLexiconCalleeEntry[];
  concept?: { terms: ConceptTerm[] };
  names: NamingLexiconNameVerdict[];
  /** e.g. `concept step skipped: …` when embeddings are unavailable. */
  notices?: string[];
  /** Set when the index predates the identifier table — names the reindex. */
  driftWarning?: string;
}
