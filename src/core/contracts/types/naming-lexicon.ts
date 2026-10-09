/**
 * Naming-lexicon value types the public DTO (`api/public/dto/naming-lexicon.ts`)
 * exposes: the shapes a `get_naming_lexicon` answer is built from. They live in
 * the foundation so the contract layer does not import the explore domain that
 * produces them (bd tea-rags-mcp-89k7k.35.8); `domains/explore/naming-lexicon`
 * imports and re-exports them. Same pattern as `architecture-report.ts`.
 */

import type { SymbolDefinitionKind } from "./codegraph-symbols.js";

/** One concept term: a snake n-gram, its summed holder score, and up to three distinct holder symbols (best first, no `#partN`). */
export interface ConceptTerm {
  term: string;
  score: number;
  holders: string[];
}

/**
 * - `EXACT` — the type rendered in the casing, singular or plural
 *   (`tax_automation_document`, `tax_automation_documents`).
 * - `QUALIFIED` — the type's words plus a qualifier before or after them
 *   (`tax_automation_document_ignored`, `source_tax_automation_document`); in a
 *   distribution, only where the owner binds the type a second time.
 * - `TAIL` — a proper suffix of the type's words, alone or after the name's own
 *   qualifier words (`document`, `source_document`).
 * - `VERB_TYPE` — on a `return`: one verb word plus the type's words
 *   (`find_tax_automation_document!`).
 * - `CALLEE_DERIVED` — a `local` / `field` named after the member it is bound
 *   to, minus a verb prefix and `!` / `?` (`x = find_x!(id)`); needs no type.
 * - `FREE` — none of the above: a role name (`row`).
 *
 * Word comparisons accept the plural of the type's last word throughout, since
 * collection annotations are unwrapped to the element type upstream.
 */
export type NamingShape = "EXACT" | "QUALIFIED" | "TAIL" | "VERB_TYPE" | "CALLEE_DERIVED" | "FREE";

/** One shape's share of a row set. */
export interface NamingShapeShare {
  shape: NamingShape;
  share: number;
}

/** The declarations one asked word heads. */
export interface TypeNameHeadCarriers {
  /** The word as asked. */
  head: string;
  /** Declarations carrying it. */
  n: number;
  /** Files they are declared in. */
  files: number;
  /** Declarations per kind. */
  kinds: Partial<Record<SymbolDefinitionKind, number>>;
  /** Up to three carrier short names, in path order. */
  examples: string[];
}

/** An established modifier offered in place of the draft's own qualifier. */
export interface TermAlternative {
  word: string;
  /**
   * `head`: the project's dominant spelling of the draft's head word
   * (`doc` for `…Document`) — `heads` is then empty, `domains` the directories
   * of the types ending in it, `lift` its count over the draft spelling's.
   * Absent: a qualifier alternative.
   */
  slot?: "head";
  heads: string[];
  domains: string[];
  lift: number;
  /**
   * The embedding similarity of this word to the draft word it replaces
   * (bd tea-rags-mcp-433d2) — the head (`numbers` → `metrics`), or the
   * qualifier / path word named by `replaces` — above the draft's corrected
   * null floor ({@link correctedSimilarityFloor}). Absent on any alternative
   * judged without embeddings.
   */
  similarity?: number;
  /** A head alternative found by meaning: project types carrying the word that anchored it (`IndexMetrics`). */
  examples?: string[];
  /**
   * The draft word this one would replace, when judged by meaning
   * (bd tea-rags-mcp-433d2). On a path-term alternative (`staleness` →
   * `freshness`) `domains` is then the directory the term names, `heads` empty
   * and `lift` 0 — no frequency is judged. On a qualifier alternative it is the
   * draft qualifier the modifier is most similar to (`calculated` →
   * `predefined`). Absent on a spelling variant and a head found by meaning
   * (both replace the head), and on any alternative judged without embeddings.
   */
  replaces?: string;
}

/** How a type role was established. */
export type TypeRoleEvidence = "inheritance" | "directory" | "projectSuffix";

/** The role a type draft was expected to carry: its word, the evidence behind it, example type names. */
export interface NamingExpectedTypeRole {
  word: string;
  evidence: TypeRoleEvidence;
  examples: string[];
  /** `false`: a dispersed family's kind — what the type IS, never a word its name owes (bd tea-rags-mcp-49fsr). */
  carriedInName?: boolean;
  /**
   * A written-supertype family's multi-word role, in the draft's casing (bd
   * tea-rags-mcp-1ffi9): the tail its members share, `word` its last word —
   * `AsyncWorkflow`. Absent: the role is `word` alone.
   */
  tail?: string;
}

/**
 * A type draft's `borderline` (bd tea-rags-mcp-89k7k.1.17): the alternatives
 * whose similarity lies inside the jitter band of the draft's floor
 * (`MEANING_FLOOR_JITTER_MARGIN`) — the embedding backend's run-to-run noise
 * could put them on either side, so they are neither offered as
 * `alternatives` nor dropped, and the verdict is the one it would be without
 * them, whichever side the noise lands. Word order. Absent when none.
 */
export type NamingBorderline = TermAlternative[];

export type NamingVerdict =
  | {
      verdict: "CONFORMS";
      /**
       * A type draft conforming by project suffix or lexical alignment alone,
       * one of whose words the project spells with another, similar word
       * (bd tea-rags-mcp-433d2) — `EmbeddingBackend` → `provider`. Never on a
       * name carrying its expected (family / directory) role. CONFORMS judges
       * vocabulary only, never whether the name fits the behaviour.
       */
      alternatives?: TermAlternative[];
      /**
       * The role a type draft's CONFORMS rests on (bd tea-rags-mcp-xsxkr): the
       * expected family / directory role its name carries, or the project
       * suffix that confirms it. With `carriedInName: false`, the kind a
       * dispersed family names for the draft (bd tea-rags-mcp-49fsr): its
       * supertype and directory say what it IS, and the family fixes no head —
       * `SendFailedPaymentNotification` extending `KindOfService` is a
       * `service`. Absent: known words alone confirmed the name.
       */
      role?: NamingExpectedTypeRole;
      /**
       * A method whose name an in-project ancestor of its owner already declares
       * (bd tea-rags-mcp-bjfa0): the supertype fixed the name, so it is never
       * novel. `declaredBy` = the nearest ancestor's declaration.
       */
      override?: { declaredBy: string };
      /**
       * A value draft conforming to its DECLARING FILE's own idiom (bd
       * tea-rags-mcp-hzrxn): the file's pre-existing bindings of the same role
       * carry the draft's name by majority — at least {@link MIN_ROLE_MEMBERS}
       * of them and at least half the role's bindings, the majority idiom the
       * type roles read. `bindings` = how many prior bindings carry the name.
       * Absent: known words alone confirmed the name.
       */
      fileLocal?: { file: string; bindings: number };
      borderline?: NamingBorderline;
    }
  | { verdict: "MISFIT"; suggestion: string; holder?: string; role?: NamingExpectedTypeRole }
  | {
      verdict: "NEW_TERM";
      topTerms: string[];
      alternatives?: TermAlternative[];
      borderline?: NamingBorderline;
    }
  /**
   * A value draft (`param`, `local`, `field`) whose type or call holds no
   * convention — no name carried by ≥ {@link MIN_ROLE_MEMBERS} owners, or no
   * rows at all (lexicon friction F3). Not a rename demand and not a free
   * choice either: the name should be the type's own ({@link NamingPreference.exact})
   * or read like the names the project gives its relatives
   * ({@link NamingPreference.analogous}) — a name unlike both is the one to justify.
   */
  | { verdict: "NO_CONVENTION"; prefer: NamingPreference }
  | { verdict: "COLLISION"; existing: { symbolId: string; relPath: string } };

/** What a NO_CONVENTION points to (lexicon friction F3). */
export interface NamingPreference {
  /** The type spelled in the draft's casing (`collectionRegistry`), plural for a `many` draft; absent untyped. */
  exact?: string;
  /**
   * Names by analogy, heaviest first, at most 5: the value names the draft's
   * own thin rows carry, then those of its type family — the types
   * specializing it (`CallerSymbolId` for `SymbolId`), else its siblings by
   * head word (`*Registry`) — see {@link withFamilyAnalogues}.
   */
  analogous: string[];
}
