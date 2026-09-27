/**
 * Hierarchy dependencies of pass-2 resolution (bd tea-rags-mcp-7t2ee) — what
 * keeps an incremental run's CHA cones equal to a full run's.
 *
 * A call site's cone is a function of the WHOLE hierarchy: `c.close()` on a
 * `Closer` fans out to every implementer, declared or `structural`. Edges are
 * reconciled per SOURCE file, so a caller whose own file did not change was
 * never revisited when an implementer appeared, disappeared, or changed its
 * members somewhere else — it kept the cone of the run that last walked it.
 *
 * So pass-2 records, per file, every type whose descendants its resolution
 * asked about ({@link HierarchyDependencyRecorder}) together with the answer,
 * and the next run's barrier re-resolves exactly the files whose answer moved
 * ({@link selectHierarchyDependents}). Language-neutral by construction: it
 * sits on `CallContext.hierarchy`, the one surface every language's cone and
 * interface-receiver strategies read the hierarchy through.
 */

import type {
  GlobalSymbolTable,
  HierarchyDescendantDependency,
  HierarchyQuery,
  HierarchyView,
  InheritanceEdge,
  PersistedHierarchyDescendantDependency,
} from "../../../../contracts/types/codegraph.js";
import { lastSegment } from "./symbol-name.js";

/**
 * The answer a dependency records for `typeName`: its TRANSITIVE descendants
 * over every kind, names only, sorted and deduplicated — independent of the
 * traversal options the asking strategy passed, so one row covers a direct
 * and a transitive read alike and compares as a plain value.
 */
export function descendantNamesOf(view: HierarchyView, typeName: string): string[] {
  const names = new Set<string>();
  for (const edge of view.getDescendants(typeName, { transitive: true })) names.add(edge.sourceFqName);
  return [...names].sort();
}

/**
 * A `HierarchyView` that answers from `inner` and remembers which types' descendant
 * sets were read — one recorder per resolved file. Ancestor reads are passed
 * through unrecorded: an unchanged type's ancestry moves only when a file on
 * its chain changes, and that is a different dependency than the cone's.
 */
export class HierarchyDependencyRecorder implements HierarchyView {
  private readonly askedDescendantsOf = new Set<string>();

  constructor(private readonly inner: HierarchyView) {}

  getAncestors(fqName: string, opts?: HierarchyQuery): readonly InheritanceEdge[] {
    return this.inner.getAncestors(fqName, opts);
  }

  getDescendants(fqName: string, opts?: HierarchyQuery): readonly InheritanceEdge[] {
    this.askedDescendantsOf.add(fqName);
    return this.inner.getDescendants(fqName, opts);
  }

  /** What this file depended on, sorted by type; `answerOf` supplies the (memoized) descendant names. */
  dependencies(answerOf: (typeName: string) => string[]): HierarchyDescendantDependency[] {
    return [...this.askedDescendantsOf].sort().map((typeName) => ({ typeName, descendantNames: answerOf(typeName) }));
  }
}

/** What the barrier knows about the current run when it decides which unchanged files to re-resolve. */
export interface HierarchyDependentSelectionInput {
  /** Persisted dependencies of the families this run walked. */
  dependencies: readonly PersistedHierarchyDescendantDependency[];
  /** The current (sealed) hierarchy of a source file's language family. */
  viewFor: (language: string) => HierarchyView | undefined;
  /** Files this run walks anyway — never re-resolved twice. */
  walkedRelPaths: ReadonlySet<string>;
  /** Whether a type is declared by a file this run walked (its members may have changed). */
  declaredByWalkedFile: (typeName: string) => boolean;
}

/**
 * The unchanged files whose recorded cone may have moved, sorted. A dependency
 * on `T` is stale when
 *
 *  - the current descendants of `T` differ from the recorded ones — an
 *    implementer was added or removed, nominally or structurally; or
 *  - a recorded or current descendant of `T` is declared by a walked file — it
 *    may have gained or dropped the member the cone pins, which leaves the
 *    descendant set equal.
 *
 * `T`'s own declaration is deliberately not a trigger: the cone reads the
 * members of `T`'s DESCENDANTS, and a change of `T`'s members that moves
 * membership shows up as a descendant change through the structural rows.
 */
export function selectHierarchyDependents(input: HierarchyDependentSelectionInput): string[] {
  const answers = new Map<HierarchyView, Map<string, string[]>>();
  const currentAnswer = (view: HierarchyView, typeName: string): string[] => {
    let perView = answers.get(view);
    if (perView === undefined) {
      perView = new Map();
      answers.set(view, perView);
    }
    let names = perView.get(typeName);
    if (names === undefined) {
      names = descendantNamesOf(view, typeName);
      perView.set(typeName, names);
    }
    return names;
  };
  const dependents = new Set<string>();
  for (const dependency of input.dependencies) {
    const { sourceRelPath } = dependency;
    if (input.walkedRelPaths.has(sourceRelPath) || dependents.has(sourceRelPath)) continue;
    const view = input.viewFor(dependency.language);
    if (view === undefined) continue;
    const current = currentAnswer(view, dependency.typeName);
    if (
      !sameNames(current, dependency.descendantNames) ||
      current.some(input.declaredByWalkedFile) ||
      dependency.descendantNames.some(input.declaredByWalkedFile)
    ) {
      dependents.add(sourceRelPath);
    }
  }
  return [...dependents].sort();
}

/**
 * `declaredByWalkedFile` over the run's symbol table: a hierarchy name is
 * looked up as written, and by its last segment when that finds nothing — a
 * `structural` row names its owner by the innermost scope segment, and
 * over-matching a namesake only re-resolves one file too many. Memoized.
 */
export function typeDeclaredByAnyOf(
  symbolTable: GlobalSymbolTable,
  relPaths: ReadonlySet<string>,
): (typeName: string) => boolean {
  const verdicts = new Map<string, boolean>();
  return (typeName) => {
    let verdict = verdicts.get(typeName);
    if (verdict === undefined) {
      let definitions = symbolTable.lookup(typeName);
      if (definitions.length === 0) definitions = symbolTable.lookupByShortName(lastSegment(typeName));
      verdict = definitions.some((definition) => relPaths.has(definition.relPath));
      verdicts.set(typeName, verdict);
    }
    return verdict;
  };
}

function sameNames(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, i) => name === b[i]);
}
