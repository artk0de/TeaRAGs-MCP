/**
 * bd tea-rags-mcp-83cl7 — the Ruby CORE member vocabulary for the core-homonym
 * denominator (`coreAmbiguous`).
 *
 * `RUBY_KERNEL_BUILTINS` (the `runtimeBuiltins` facet) answers the BARE-CALL
 * question: "is this no-receiver name a Kernel/Object method available with no
 * `require`?" That set is already half of the core-member vocabulary — every
 * `to_s` / `dup` / `hash` / `inspect` in it is equally a homonym candidate on an
 * explicit receiver. What it does NOT contain, because they are not callable
 * bare, are the Enumerable / Array / Hash / String / Numeric universals —
 * `each`, `map`, `first`, `join`, `merge`, `to_h`. {@link RUBY_ENUMERABLE_MEMBERS}
 * is EXACTLY that complement, and {@link RUBY_CORE_MEMBERS} is the union. No name
 * is written in both sets: the Kernel set stays the single authority for the
 * names it holds.
 *
 * Why a complement rather than an extension of `RUBY_KERNEL_BUILTINS` itself:
 * that set feeds `hasExternalMember` → `isExternalBareCall`, so adding `each` to
 * it would silently reclassify a BARE `each` as ykj7 `externalSkipped`. The
 * core-member axis is about an EXPLICIT untyped receiver; keeping the two sets
 * distinct keeps the bare-call classifier byte-identical.
 *
 * DELIBERATELY EXCLUDED, because a project def of the same name is the DOMINANT
 * reading and classifying them would HIDE a real recall hole (precision here
 * runs in reverse):
 *   - `call` / `new` — the service-object and factory idioms.
 *   - `present?` / `blank?` / `try` / `presence` — ActiveSupport, not Ruby core.
 *   - `where` / `order` / `includes` / `pluck` / `find_by` / `as_json` —
 *     ActiveRecord relation vocabulary; a separate axis, not core.
 *   - every name already owned by `ACTIVE_RECORD_INSTANCE_BUILTINS`
 *     (`delete`, `update`, `destroy`, `reload`, …) — those are classified
 *     EXTERNAL one step earlier by `isQualifiedMemberExternal`, so listing them
 *     here would be a second authority for the same name.
 */
import { RUBY_KERNEL_BUILTINS } from "./kernel-builtins.js";

/**
 * Ruby core members reachable on an explicit receiver but NOT callable bare —
 * the complement of {@link RUBY_KERNEL_BUILTINS} within the core vocabulary.
 * Enumerable / Array / Hash / String / Numeric / Comparable surface only; a name
 * that might be a gem extension is omitted (same conservative rule the Kernel
 * set documents — an omitted name merely stays in the miss pool).
 */
export const RUBY_ENUMERABLE_MEMBERS: ReadonlySet<string> = new Set<string>([
  // ── Enumerable: iteration ───────────────────────────────────────────────
  "each",
  "each_with_index",
  "each_with_object",
  "each_entry",
  "each_slice",
  "each_cons",
  "each_pair",
  "each_key",
  "each_value",
  "each_index",
  "each_char",
  "each_line",
  "each_byte",
  "times",
  "upto",
  "downto",
  "step",
  "cycle",
  "lazy",
  // ── Enumerable: transformation ──────────────────────────────────────────
  "map",
  "map!",
  "collect",
  "collect_concat",
  "flat_map",
  "select",
  "select!",
  "filter",
  "filter_map",
  "reject",
  "reject!",
  "detect",
  "find",
  "find_all",
  "find_index",
  "reduce",
  "inject",
  "sum",
  "min",
  "max",
  "min_by",
  "max_by",
  "minmax",
  "sort",
  "sort!",
  "sort_by",
  "group_by",
  "partition",
  "chunk_while",
  "slice_when",
  "zip",
  "take",
  "take_while",
  "drop",
  "drop_while",
  "tally",
  "to_a",
  "to_h",
  // ── Enumerable / Comparable: predicates ─────────────────────────────────
  "any?",
  "all?",
  "none?",
  "one?",
  "empty?",
  "include?",
  "member?",
  "cover?",
  "between?",
  "clamp",
  // ── Array / Hash: access + mutation ─────────────────────────────────────
  "first",
  "last",
  "push",
  "pop",
  "shift",
  "unshift",
  "append",
  "concat",
  "insert",
  "fill",
  "index",
  "at",
  "dig",
  "fetch",
  "store",
  "slice",
  "slice!",
  "values_at",
  "keys",
  "values",
  "key",
  "key?",
  "has_key?",
  "has_value?",
  "value?",
  "invert",
  "merge",
  "merge!",
  "delete_if",
  "keep_if",
  "except",
  "transform_keys",
  "transform_values",
  "clear",
  "count",
  "size",
  "length",
  "flatten",
  "flatten!",
  "compact",
  "compact!",
  "uniq",
  "uniq!",
  "reverse",
  "reverse!",
  "rotate",
  "sample",
  "shuffle",
  "transpose",
  "assoc",
  "join",
  // ── String ──────────────────────────────────────────────────────────────
  "split",
  "strip",
  "strip!",
  "chomp",
  "chop",
  "upcase",
  "downcase",
  "capitalize",
  "swapcase",
  "gsub",
  "gsub!",
  "sub",
  "sub!",
  "tr",
  "squeeze",
  "scan",
  "match",
  "match?",
  "start_with?",
  "end_with?",
  "ljust",
  "rjust",
  "center",
  "chars",
  "bytes",
  "lines",
  "bytesize",
  "casecmp",
  "casecmp?",
  "encode",
  "force_encoding",
  "unpack",
  "unpack1",
  "intern",
  "succ",
  "ord",
  "hex",
  "oct",
  // ── Conversions (Object / String / Numeric) ─────────────────────────────
  "to_i",
  "to_f",
  "to_r",
  "to_c",
  "to_sym",
  "to_str",
  // ── Numeric ─────────────────────────────────────────────────────────────
  "round",
  "ceil",
  "floor",
  "truncate",
  "abs",
  "divmod",
  "modulo",
  "pow",
  "coerce",
  "zero?",
  "positive?",
  "negative?",
  "even?",
  "odd?",
  "finite?",
  "infinite?",
  "nan?",
]);

/**
 * The full Ruby CORE member vocabulary: the Kernel/Object bare-call names plus
 * the explicit-receiver-only complement. Composed here so neither set repeats a
 * name — the union is derived, never hand-maintained.
 */
export const RUBY_CORE_MEMBERS: ReadonlySet<string> = new Set<string>([
  ...RUBY_KERNEL_BUILTINS,
  ...RUBY_ENUMERABLE_MEMBERS,
]);
