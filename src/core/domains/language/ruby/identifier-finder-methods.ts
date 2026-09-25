/**
 * ActiveRecord finders whose result, on a constant receiver, is an instance of
 * that constant (bd tea-rags-mcp-4p3sb.9): `doc = TaxDocument.find_by!(id: id)`
 * binds `doc` to a `TaxDocument`. The codegraph row builder reads this list via
 * `LanguageProvider.identifierFinderMethods` for the naming lexicon's `finder`
 * type-recovery stage; the vocabulary is Ruby knowledge, so it lives here.
 *
 * A finder on a relation chain (`Doc.where(x).first`) is not covered: its
 * receiver is not a constant, so the row builder never consults this list for it.
 */
export const RUBY_IDENTIFIER_FINDER_METHODS: readonly string[] = [
  "find",
  "find!",
  "find_by",
  "find_by!",
  "first",
  "last",
  "take",
  "create",
  "create!",
  "find_or_create_by",
  "find_or_initialize_by",
];
