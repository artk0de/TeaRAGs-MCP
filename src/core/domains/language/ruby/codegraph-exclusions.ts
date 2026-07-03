/**
 * Rails non-application-code path globs — files that parse as Ruby and enter the
 * codegraph but are NOT part of the application call graph, so they must be kept
 * out of the fan-graph and the `resolveSuccessRate` denominator.
 *
 * A migration / data-migration is a procedural schema operation on an untyped
 * ORM builder (`t.datetime`, `t.integer` on the block receiver `t`), not real
 * method dispatch — every such call is a dynamic-receiver miss that can never
 * resolve to an in-project definition, inflating the denominator with a whole
 * false bucket (~1021 holes measured on taxdome, 2026-07-03). `db/schema.rb` /
 * `db/data_schema.rb` are the generated snapshots of the same procedural DSL.
 *
 * Ownership: this is Ruby-language knowledge, so it lives in the Ruby language
 * domain — mirroring how the walker / resolver capabilities do — rather than in
 * the language-agnostic `infra/file-classification` or the generic codegraph
 * exclusion. `buildCodegraphExclusionFilter` aggregates these per registered
 * language via the injected `LanguageFactoryDescriptor`; the generic engine
 * hardcodes no `db/` or `ruby` knowledge of its own (bd tea-rags-mcp-biwbq).
 *
 * codegraph-ONLY: semantic search still indexes these files (a migration is a
 * legitimate "when did column X appear" search target) — only the call graph
 * drops them. `.gitignore` glob syntax (the `ignore` package).
 *
 * NOTE: `db/schema.rb` is ALSO a generated file and remains covered by
 * `infra/file-classification` `GENERATED_PATTERNS` for the separate git-skip
 * classification axis; it is listed here so the Ruby domain declares its full
 * non-app codegraph surface in one place. `db/migrate` / `db/data` are
 * hand-written (not generated) — they SHOULD keep their git ownership signals,
 * so they belong ONLY on this codegraph-only axis, not in `GENERATED_PATTERNS`.
 */
export const RUBY_CODEGRAPH_EXCLUSION_GLOBS: readonly string[] = [
  "**/db/migrate/**",
  "**/db/data/**",
  "**/db/schema.rb",
  "**/db/data_schema.rb",
];
