/**
 * Homonym judgement: whether one name bound to several types names several
 * concepts. Two readings look like homonyms and are not:
 *   - one class spelled unqualified and qualified (`Document` beside
 *     `TaxPreparation::Document`) — the type recovery saw the same class twice;
 *   - the role word a type FAMILY shares as its tail (`state` for
 *     `ClientState` and `RunState`), spelled out or abbreviated (`ctx` for
 *     `LogContext` and `ReindexContext`) — correct naming, one role over many
 *     types.
 * Pure: the shapes come in already classified by the caller.
 */
import { stripIdentifierDecorations, typeNameLastSegment, typeNameWords } from "./casing.js";
import type { NamingShape } from "./shapes.js";

/** One type a name is bound to, with the name's row count against it. */
export interface HomonymTypeCount {
  typeName: string;
  n: number;
}

/** One type a name is bound to, with the name's shape against it. */
export interface HomonymTypeShape {
  typeName: string;
  shape: NamingShape;
}

/** No namespace separator outside generic arguments: `Document`, not `Billing::Document` or `pkg.Document`. */
function isUnqualified(typeName: string): boolean {
  return !/::|\./.test(typeName.replace(/[<[].*$/, ""));
}

/**
 * Folds each unqualified type into the ONE other type sharing its last
 * segment, summing counts; the qualified entry keeps its own fields (spelling,
 * example). An unqualified type matching zero or two-plus others stays — which
 * class it spells is unknown. Returns the types by count, largest first.
 */
export function mergeUnqualifiedTypeSpellings<T extends HomonymTypeCount>(types: readonly T[]): T[] {
  const merged = types.map((type) => ({ ...type }));
  const absorbed = new Set<number>();
  merged.forEach((type, i) => {
    if (!isUnqualified(type.typeName)) return;
    const segment = typeNameLastSegment(type.typeName);
    const targets = merged
      .map((other, j) => ({ other, j }))
      .filter(({ other, j }) => j !== i && !absorbed.has(j) && typeNameLastSegment(other.typeName) === segment);
    if (targets.length !== 1) return;
    targets[0].other.n += type.n;
    absorbed.add(i);
  });
  return merged.filter((_, i) => !absorbed.has(i)).sort((a, b) => b.n - a.n || a.typeName.localeCompare(b.typeName));
}

/**
 * True when `abbreviation` abbreviates `word` (both compared lowercase): it
 * starts with the word's first letter, its letters occur in the word in order,
 * and it is 2+ letters and shorter than the word — `ctx` / Context, `cfg` /
 * Config, `opts` / Options. Letters only: `ctx2` abbreviates nothing.
 */
function isWordAbbreviation(abbreviation: string, word: string): boolean {
  const abbr = abbreviation.toLowerCase();
  const full = word.toLowerCase();
  if (!/^[a-z]+$/.test(abbr) || abbr.length < 2 || abbr.length >= full.length) return false;
  if (!full.startsWith(abbr[0])) return false;
  let at = 0;
  for (const letter of abbr) {
    at = full.indexOf(letter, at) + 1;
    if (at === 0) return false;
  }
  return true;
}

/**
 * True when `name` abbreviates the word a type ends in (`ctx` / `LogContext`).
 * A type of exactly two words also accepts its FIRST word, the head of a
 * `<Concept><Kind>` compound whose kind word is generic (`err` /
 * `NodeJS.ErrnoException`: an errno IS the error). Longer types do not — a
 * middle word is a qualifier, not what the value is.
 */
function abbreviatesTypeRole(name: string, typeName: string): boolean {
  const words = typeNameWords(typeName);
  if (words.length === 0) return false;
  const bare = stripIdentifierDecorations(name);
  if (isWordAbbreviation(bare, words[words.length - 1])) return true;
  return words.length === 2 && isWordAbbreviation(bare, words[0]);
}

/**
 * True when a name bound to two or more types is the role word of a type
 * family, not a homonym: against EVERY type the name is EXACT or TAIL, or —
 * when `name` is given — an abbreviation of that type's role word
 * ({@link abbreviatesTypeRole}); and the types' last segments are pairwise
 * distinct. Two types sharing a last segment across namespaces
 * (`GrowthBilling::Subscription`, `Subscriptions::Subscription`) are two
 * concepts under one simple name — a real homonym.
 */
export function isTypeFamilyRoleName(types: readonly HomonymTypeShape[], name?: string): boolean {
  if (types.length < 2) return false;
  const namesRole = (type: HomonymTypeShape): boolean =>
    type.shape === "EXACT" || type.shape === "TAIL" || (name !== undefined && abbreviatesTypeRole(name, type.typeName));
  if (!types.every(namesRole)) return false;
  const segments = new Set(types.map((type) => typeNameLastSegment(type.typeName)));
  return segments.size === types.length;
}
