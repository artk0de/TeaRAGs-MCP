/**
 * "Which types is this receiver actually made of?" — the one flattening both
 * checker-backed receiver guards ask before deciding anything (bd
 * tea-rags-mcp-6o7bi).
 *
 * `ts.Type#getSymbol()` returns `undefined` for a UNION and for an
 * INTERSECTION alike: neither is declared anywhere, they are built out of parts
 * that are. `typeDeclaredOutsideProject` (./ts-external-call.ts) already split
 * unions for that reason; intersections were left whole, so every one of them
 * reached the symbol lookup as a single unnamed type and both guards read the
 * missing symbol as "no evidence".
 *
 * That is not a corner case. `process.stdout` is `WriteStream & { fd: 1 }`, and
 * every branded, augmented or `Object.assign`-ed dependency value takes the same
 * shape — on this repo's own `src` it is 50 of the 94 calls left in the
 * `resolveSuccessRate` denominator for a `chain` receiver, all of them
 * `process.stdout.write(...)` resolving into `@types/node`.
 *
 * Flattening is all this does. What the two guards then DO with the parts stays
 * opposite and stays theirs: one declines only when EVERY part is declared
 * outside the project, the other keeps the edge when ANY part is declared
 * inside it.
 */

import type ts from "typescript";

/**
 * Every leaf type behind `type`, with unions and intersections walked through
 * and each leaf resolved to its apparent type.
 *
 * `getApparentType` is applied at the LEAVES rather than at the root, which is
 * what makes a type-parameter constituent (`T extends Writer`) resolve to its
 * constraint the same way a bare one does. It can itself yield a union or
 * intersection — an apparent type is a real type — so the result is pushed back
 * for another pass rather than yielded blind.
 *
 * The `seen` set is what guarantees termination: a leaf whose apparent type is
 * itself would otherwise cycle, and the compiler makes no promise that it is
 * not. Identity is the right test — the checker interns types, so the same
 * constituent reached twice is the same object.
 */
export function typeConstituents(checker: ts.TypeChecker, type: ts.Type): ts.Type[] {
  const leaves: ts.Type[] = [];
  const seen = new Set<ts.Type>();
  const pending: ts.Type[] = [type];
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined || seen.has(next)) continue;
    seen.add(next);
    if (next.isUnionOrIntersection()) {
      pending.push(...next.types);
      continue;
    }
    const apparent = checker.getApparentType(next);
    if (apparent !== next && apparent.isUnionOrIntersection()) {
      pending.push(apparent);
      continue;
    }
    leaves.push(apparent);
  }
  return leaves;
}
