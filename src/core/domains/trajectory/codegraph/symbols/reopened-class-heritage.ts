/**
 * Heritage of an OPEN class — one that any number of files may reopen — folded
 * across every file that declares it (bd tea-rags-mcp-89k7k.35.30).
 *
 * The run-global ancestry maps are keyed by class FQ. In a language whose class
 * declaration is final (Python, TypeScript) a second file declaring the name is a
 * different class, and the map keeps one answer. In Ruby it is the SAME class:
 * `class Directive < Member` in `directive/feature.rb` reopens the class
 * `directive.rb` declared, and every reopening adds to it — the superclass is
 * declared at most once (a reopening without `< X` keeps it; a conflicting one is
 * a `TypeError` at load), while `include` / `extend` / `prepend` accumulate.
 * Letting one file's entry replace another's kept whichever reopening the run
 * absorbed last: on graphql-ruby the relPath-sorted walk ended on a reopening
 * that only restates `< Member` and lost `Directive`'s `extend HasArguments`.
 *
 * {@link ReopenedClassHeritage} keeps each file's contribution per class and
 * settles the merged value from all of them in relPath order, so the answer
 * depends neither on absorb order nor on which files the run walked versus
 * hydrated — a walked file and a persisted slice are contributions alike, and a
 * file contributing again replaces its own earlier contribution.
 */
import type { RelPath } from "../../../../contracts/types/codegraph.js";
import { languageFamilyOf } from "./language-family-record.js";

/** The language families whose classes are open: a same-FQ declaration in another file reopens the class. */
const OPEN_CLASS_LANGUAGE_FAMILIES: ReadonlySet<string> = new Set(["ruby"]);

/** Whether `language`'s class declarations reopen — rather than shadow — a same-FQ declaration elsewhere. */
export function declaresOpenClasses(language: string): boolean {
  return OPEN_CLASS_LANGUAGE_FAMILIES.has(languageFamilyOf(language));
}

/**
 * One file's `classAncestors` entry for a class. Ruby's walker writes the
 * superclass FIRST and the mixins after it, and records the same superclass in
 * `classExtends` — which is how the fold tells the two apart.
 */
export interface ReopenedClassAncestors {
  readonly list: readonly string[];
  readonly superclass: string | undefined;
}

/**
 * Per-class, per-file contributions to one run-global map, keyed by the map's
 * family partition OBJECT — a reset seam that replaces the store forgets its
 * contributions with it.
 */
export class ReopenedClassHeritage<C, V> {
  private readonly byPartition = new WeakMap<object, Map<string, Map<RelPath, C>>>();

  constructor(private readonly settle: (ordered: readonly C[]) => V) {}

  /** Record `relPath`'s contribution to `className` and answer the class's merged value. */
  contribute(partition: object, className: string, relPath: RelPath, contribution: C): V {
    let classes = this.byPartition.get(partition);
    if (classes === undefined) {
      classes = new Map();
      this.byPartition.set(partition, classes);
    }
    let files = classes.get(className);
    if (files === undefined) {
      files = new Map();
      classes.set(className, files);
    }
    files.set(relPath, contribution);
    const ordered = [...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, value]) => value);
    return this.settle(ordered);
  }
}

/**
 * The mixins `list` holds, without its leading superclass. A file's superclass
 * always leads its list, so stripping it never touches a mixin.
 */
function mixinsOf(contribution: ReopenedClassAncestors): readonly string[] {
  return contribution.superclass !== undefined && contribution.list[0] === contribution.superclass
    ? contribution.list.slice(1)
    : contribution.list;
}

/**
 * `classAncestors` of a reopened class: the first superclass any reopening
 * declares, in relPath order, then every reopening's mixins in relPath then
 * declaration order, each once. A conflicting later superclass is dropped, as
 * Ruby would refuse it. A class one file declares keeps that file's list as is.
 */
export function settleReopenedClassAncestors(ordered: readonly ReopenedClassAncestors[]): readonly string[] {
  if (ordered.length === 1) return ordered[0].list;
  const superclass = ordered.find((contribution) => contribution.superclass !== undefined)?.superclass;
  const merged: string[] = superclass === undefined ? [] : [superclass];
  for (const contribution of ordered) {
    for (const mixin of mixinsOf(contribution)) {
      if (!merged.includes(mixin)) merged.push(mixin);
    }
  }
  return merged;
}

/** `classPrependedAncestors` of a reopened class: every reopening's prepends, relPath then declaration order, each once. */
export function settleReopenedClassPrepends(ordered: readonly (readonly string[])[]): readonly string[] {
  if (ordered.length === 1) return ordered[0];
  const merged: string[] = [];
  for (const prepends of ordered) {
    for (const mixin of prepends) {
      if (!merged.includes(mixin)) merged.push(mixin);
    }
  }
  return merged;
}

/** `classExtends` of a reopened class: the superclass the first reopening by relPath declares. */
export function settleReopenedClassSuperclass(ordered: readonly string[]): string {
  return ordered[0];
}
