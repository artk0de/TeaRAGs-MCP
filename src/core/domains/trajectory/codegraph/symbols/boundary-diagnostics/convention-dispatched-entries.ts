/**
 * Convention-dispatched entry points (bd tea-rags-mcp-r8hme.52.13): files a
 * framework reaches through a convention — a route table naming controllers,
 * a string a contract registry constantizes, a job queue — instead of a
 * constant reference, so no file edge ever names them. Measured from the
 * subtype families the graph already records, never from a path or name list.
 *
 * A supertype's FAMILY is every file declaring a type that extends it,
 * directly or through an intermediate in-project supertype (transitively
 * closed: a framework base reaches its endpoints through per-area bases, and
 * a per-area base of two endpoints is too small to judge alone). A member is
 * UNREACHED when its component has no afferent file (Ca 0). A family is
 * DISPATCHED when unreached members are both
 *
 *   - the rule — a strict majority of the family — and
 *   - more than chance — a binomial upper tail against the corpus rate of
 *     unreached subtypes, Benjamini–Hochberg over every family at the
 *     conventional FDR.
 *
 * The rate is the evidence, not the base: dead subclasses of a base whose
 * subclasses are referenced as a rule stay dead code, and a family where
 * nobody references anything is how a framework instantiates by convention.
 */

import type { FileDependencyGraphFile, RelPath } from "../../../../../contracts/types/codegraph.js";
import {
  benjaminiHochbergRejectionCount,
  binomialUpperTail,
  CONVENTIONAL_FDR_Q,
} from "../../../../../primitives/math/index.js";
import type { ComponentGraph } from "./types.js";

/** The member files of every convention-dispatched supertype family. */
export function measureConventionDispatchedFiles(
  componentGraph: ComponentGraph,
  files: readonly FileDependencyGraphFile[],
): ReadonlySet<RelPath> {
  const unreached = (relPath: RelPath): boolean => {
    const component = componentGraph.componentOf.get(relPath);
    return component !== undefined && componentGraph.components.get(component)?.afferentCount === 0;
  };

  const families = subtypeFamilies(files.filter((f) => componentGraph.componentOf.has(f.relPath)));
  const subtypeFiles = new Set([...families.values()].flatMap((familyMembers) => [...familyMembers]));
  if (subtypeFiles.size === 0) return new Set();
  const corpusUnreachedRate = [...subtypeFiles].filter(unreached).length / subtypeFiles.size;

  const tested = [...families.values()]
    .map((familyMembers) => {
      const unreachedCount = [...familyMembers].filter(unreached).length;
      return {
        familyMembers,
        unreachedCount,
        pValue: binomialUpperTail(unreachedCount, familyMembers.size, corpusUnreachedRate),
      };
    })
    .sort((a, b) => a.pValue - b.pValue);
  const rejected = benjaminiHochbergRejectionCount(
    tested.map((family) => family.pValue),
    tested.length,
    CONVENTIONAL_FDR_Q,
  );

  const dispatchedFiles = new Set<RelPath>();
  for (const family of tested.slice(0, rejected)) {
    if (family.unreachedCount * 2 <= family.familyMembers.size) continue;
    for (const member of family.familyMembers) dispatchedFiles.add(member);
  }
  return dispatchedFiles;
}

/**
 * Supertype → the files declaring a subtype of it, transitively closed. A
 * supertype is keyed by its name and the files declaring it, the identity
 * `typeHeritage` resolves.
 */
function subtypeFamilies(files: readonly FileDependencyGraphFile[]): Map<string, Set<RelPath>> {
  const families = new Map<string, Set<RelPath>>();
  const familiesDeclaredIn = new Map<RelPath, string[]>();
  for (const file of files) {
    for (const heritage of file.typeHeritage ?? []) {
      for (const supertype of heritage.supertypes) {
        const declaring = [...supertype.declaringRelPaths].sort();
        const key = `${supertype.name}\u0000${declaring.join("\u0000")}`;
        let familyMembers = families.get(key);
        if (!familyMembers) {
          familyMembers = new Set();
          families.set(key, familyMembers);
          for (const relPath of declaring) {
            const declared = familiesDeclaredIn.get(relPath);
            if (declared) declared.push(key);
            else familiesDeclaredIn.set(relPath, [key]);
          }
        }
        familyMembers.add(file.relPath);
      }
    }
  }

  // Fixed point: a member that itself declares a supertype brings that
  // family's members in. Cycles terminate — membership only grows.
  let grew = true;
  while (grew) {
    grew = false;
    for (const [key, familyMembers] of families) {
      for (const member of [...familyMembers]) {
        for (const nestedKey of familiesDeclaredIn.get(member) ?? []) {
          if (nestedKey === key) continue;
          for (const nested of families.get(nestedKey) ?? []) {
            if (familyMembers.has(nested)) continue;
            familyMembers.add(nested);
            grew = true;
          }
        }
      }
    }
  }
  return families;
}
