/**
 * Rails `String#singularize` for association / table names — a port of
 * ActiveSupport's default English singular inflections
 * (`active_support/inflections.rb`): the uncountables, the irregulars and the
 * singular rules, applied the way `ActiveSupport::Inflector#apply_inflections`
 * applies them (uncountable last word → unchanged; otherwise the LAST-defined
 * matching rule wins, first match only). So `statuses → status`,
 * `status → status`, `analyses → analysis`, `responses → response`,
 * `people → person`. Application-defined inflections (`config/initializers/
 * inflections.rb`) are out of scope; an explicit `class_name:` always wins
 * upstream.
 *
 * Callers singularize only what Rails singularizes: a COLLECTION association
 * (`has_many` / `habtm`) name or a table name. A singular association name
 * (`belongs_to :status`) is camelized as-is — feeding it here is the caller's
 * bug, and for most `-s` words the rules below would strip a letter.
 *
 * Lives in `dsl/` (pure data) so the `rails.ts` association `declares` can use
 * it for `_ids` accessors without a `dsl/ → walker/` import cycle. The walker
 * (`associationModelConstant`) imports it back via the barrel.
 */

/** ActiveSupport `uncountable` words — singularize leaves them unchanged. */
const UNCOUNTABLE_VOCABULARY: ReadonlySet<string> = new Set([
  "equipment",
  "information",
  "rice",
  "money",
  "species",
  "series",
  "fish",
  "sheep",
  "jeans",
  "police",
]);

/**
 * ActiveSupport singular rules in DEFINITION order (irregulars appended as
 * Rails' `irregular` does). Applied last-to-first; the first match wins.
 */
const SINGULAR_RULES: readonly (readonly [RegExp, string])[] = [
  [/s$/i, ""],
  [/(ss)$/i, "$1"],
  [/(n)ews$/i, "$1ews"],
  [/([ti])a$/i, "$1um"],
  [/((a)naly|(b)a|(d)iagno|(p)arenthe|(p)rogno|(s)ynop|(t)he)(sis|ses)$/i, "$1sis"],
  [/(^analy)(sis|ses)$/i, "$1sis"],
  [/([^f])ves$/i, "$1fe"],
  [/(hive)s$/i, "$1"],
  [/(tive)s$/i, "$1"],
  [/([lr])ves$/i, "$1f"],
  [/([^aeiouy]|qu)ies$/i, "$1y"],
  [/(s)eries$/i, "$1eries"],
  [/(m)ovies$/i, "$1ovie"],
  [/(x|ch|ss|sh)es$/i, "$1"],
  [/^(m|l)ice$/i, "$1ouse"],
  [/(bus)(es)?$/i, "$1"],
  [/(o)es$/i, "$1"],
  [/(shoe)s$/i, "$1"],
  [/(cris|test)(is|es)$/i, "$1is"],
  [/^(a)x[ie]s$/i, "$1xis"],
  [/(octop|vir)(us|i)$/i, "$1us"],
  [/(alias|status)(es)?$/i, "$1"],
  [/^(ox)en/i, "$1"],
  [/(vert|ind)ices$/i, "$1ex"],
  [/(matr)ices$/i, "$1ix"],
  [/(quiz)zes$/i, "$1"],
  [/(database)s$/i, "$1"],
  // irregular(singular, plural) registers both the plural and the singular form.
  [/(p)erson$/i, "$1erson"],
  [/(p)eople$/i, "$1erson"],
  [/(m)an$/i, "$1an"],
  [/(m)en$/i, "$1an"],
  [/(c)hild$/i, "$1hild"],
  [/(c)hildren$/i, "$1hild"],
  [/(s)ex$/i, "$1ex"],
  [/(s)exes$/i, "$1ex"],
  [/(m)ove$/i, "$1ove"],
  [/(m)oves$/i, "$1ove"],
  [/(z)ombie$/i, "$1ombie"],
  [/(z)ombies$/i, "$1ombie"],
];

export function singularizeAssociation(word: string): string {
  const lastWord = /[A-Za-z0-9]+$/.exec(word)?.[0] ?? "";
  if (word.length === 0 || UNCOUNTABLE_VOCABULARY.has(lastWord.toLowerCase())) return word;
  for (let i = SINGULAR_RULES.length - 1; i >= 0; i--) {
    const [rule, replacement] = SINGULAR_RULES[i];
    if (rule.test(word)) return word.replace(rule, replacement);
  }
  return word;
}
