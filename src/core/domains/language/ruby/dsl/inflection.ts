/**
 * Naive Rails singularize for the common association-name → model-name cases
 * (duzy). Handles `categories → category` (ies → y), `boxes → box`
 * (xes/ses/shes/ches → strip `es`), and the dominant `posts → post`
 * (trailing `s`). NOT a full inflector — irregulars (`people`, `mice`) and
 * `class_name:` overrides are out of scope here; an explicit `class_name:`
 * always wins upstream. A non-plural word passes through unchanged.
 *
 * Lives in `dsl/` (pure data) so the `rails.ts` association `declares` can use
 * it for `_ids` accessors without a `dsl/ → walker/` import cycle. The walker
 * (`associationModelConstant`) imports it back via the barrel.
 */
export function singularizeAssociation(word: string): string {
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (/(?:xes|ses|shes|ches)$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}
