/**
 * Framework-vocabulary activation, shared by every language that gates a
 * vocabulary on what the project declares (K8, bd tea-rags-mcp-m99j1.1.8).
 *
 * One rule, previously held twice (Ruby's DSL catalogue, Python's framework
 * vocabularies): a vocabulary without `activatedBy` is unconditional and always
 * loads; a gated one loads iff its activation family intersects the declared
 * dependencies, by EXACT name; and no declared set at all — no manifest — keeps
 * every vocabulary on, because absence of a manifest is absence of evidence.
 * An empty set is a different answer: a manifest that declares nothing.
 *
 * WHERE the declared set comes from stays the language's business (its
 * `DependencyManifestSource`); this module only decides who is active.
 */

/** The activation-relevant shape of one framework vocabulary. */
export interface FrameworkVocabularyDescriptor {
  readonly framework: string;
  /** Dependency names that switch this vocabulary on; absent → unconditional. */
  readonly activatedBy?: ReadonlySet<string>;
}

const setsIntersect = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => {
  for (const x of a) if (b.has(x)) return true;
  return false;
};

/** A language's registered vocabularies and the activation rule over them. */
export class FrameworkVocabularyRegistry<V extends FrameworkVocabularyDescriptor> {
  /** Keyed by the declared-set INSTANCE (weak → evicts with the set): a run holds one. */
  private readonly activeByDeclared = new WeakMap<ReadonlySet<string>, readonly V[]>();

  constructor(private readonly all: readonly V[]) {}

  /**
   * The vocabularies active for `declared`, in registration order. `null` /
   * `undefined` (no manifest) → every vocabulary. Memoised per set instance.
   */
  active(declared: ReadonlySet<string> | null | undefined): readonly V[] {
    if (declared === null || declared === undefined) return this.all;
    const cached = this.activeByDeclared.get(declared);
    if (cached !== undefined) return cached;
    const active = this.all.filter((v) => v.activatedBy === undefined || setsIntersect(v.activatedBy, declared));
    this.activeByDeclared.set(declared, active);
    return active;
  }
}
