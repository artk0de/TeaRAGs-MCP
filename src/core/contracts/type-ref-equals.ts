import type { TypeRef } from "./types/language.js";

/**
 * Structural equality over every `TypeRef` form. Union arms compare IN ORDER:
 * `typeRefUnionOf` fixes a deterministic order at construction, so two refs
 * built from the same facts compare equal, and a hand-built ref that genuinely
 * lists its arms differently is not silently treated as the same statement.
 */
export function typeRefEquals(a: TypeRef, b: TypeRef): boolean {
  if (a.form !== b.form) return false;
  if (a.form === "nil") return true;
  if (a.form === "container") return typeRefEquals(a.element, (b as { element: TypeRef }).element);
  if (a.form === "union") {
    const other = (b as { members: readonly TypeRef[] }).members;
    return a.members.length === other.length && a.members.every((m, i) => typeRefEquals(m, other[i]));
  }
  if (a.form === "tuple") {
    const other = (b as { elements: readonly TypeRef[] }).elements;
    return a.elements.length === other.length && a.elements.every((e, i) => typeRefEquals(e, other[i]));
  }
  return a.name === (b as { name: string }).name;
}
