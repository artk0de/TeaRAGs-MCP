/**
 * Ruby container vocabularies shared by the walker and the resolver.
 *
 * {@link CONTAINER_ELEMENT_RETURNING_METHODS} is the unwrap set the resolver's
 * `returnTypeOf` applies to a `container` receiver, and
 * {@link CONTAINER_BLOCK_ITERATION_METHODS} is its walk-time sibling for block
 * parameters. They live in this contracts-only leaf so the walker's inline
 * type sources read them without importing the resolver (bd
 * tea-rags-mcp-0qaht.37); the resolver re-exports both from
 * `ruby-member-return-types.ts` and `type-propagation.ts`, so every resolver
 * consumer keeps its address.
 */

/**
 * Array/Enumerable methods that return a SINGLE ELEMENT from a typed container.
 * When `recv` is `{form:"container", element:E}` and the member is in this set,
 * `returnTypeOf` unwraps the container and returns `E` so multi-hop chains like
 * `posts.first.title` thread correctly: posts→container(Post), .first→Post,
 * .title→Post#title.
 *
 * Non-element methods (`size`, `count`, `map`, `length`) are intentionally
 * absent — those operate on the container itself (Array/Enumerable = external)
 * and their return types are not trackable without a full Enumerable type model.
 */
export const CONTAINER_ELEMENT_RETURNING_METHODS = new Set([
  "first",
  "last",
  "[]",
  "fetch",
  "sample",
  "find",
  "detect",
  "min",
  "max",
  "dig",
]);

/**
 * Block-iteration methods whose FIRST block parameter is bound to the container's
 * element type at walk-time. When `recv` has a known container element type E,
 * `posts.each { |p| … }` binds `p` to `E`. This constant is the single source
 * of truth for the block-param inference set (bd Increment B / B-block) used by
 * both `rubyAstInferenceTypeSource` (via the `latestBinding` seed) and
 * `collectLocalBindingsForChunk` (via `RUBY_BLOCK_ITERATOR_METHODS`).
 *
 * Exported here so the engine and the walker share one definition; the walker's
 * `RUBY_BLOCK_ITERATOR_METHODS` re-exports this.
 */
export const CONTAINER_BLOCK_ITERATION_METHODS = new Set([
  "each",
  "map",
  "collect",
  "select",
  "filter",
  "filter_map",
  "reject",
  "find",
  "detect",
  "find_all",
  "flat_map",
  "each_with_index",
  "each_with_object",
  "group_by",
  "sort_by",
  "min_by",
  "max_by",
  "partition",
]);
