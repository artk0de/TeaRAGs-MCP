/**
 * Ruby's SELF-COPY verbs (bd tea-rags-mcp-m99j1.1.91): `Kernel#dup`,
 * `Kernel#clone` and `Kernel#itself` answer an object of the receiver's own
 * class. A paren-less `copy = dup` parses as a bare identifier, so the walker
 * records it as a call-result binding only for these names, and the resolver
 * types the result as the caller's own class.
 *
 * A zero-import leaf shared by walker and resolver (`codegraph-walkers.md`:
 * walker↔resolver markers live once, at the language root).
 */
export const RUBY_SELF_COPY_METHODS: ReadonlySet<string> = new Set(["dup", "clone", "itself"]);
