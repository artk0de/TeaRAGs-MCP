/**
 * Kaminari pagination gem. Kaminari's value to the call graph is NOT a declaring
 * macro — it is the four scopes it grafts onto `ActiveRecord::Relation`:
 *
 *   page, per, padding, without_count
 *
 * Each returns the relation, so `Post.page(1).per(20)` is still a relation OF
 * Post and `Post.page(1).first` is still a Post. Modelled with the
 * `relationReturning` facet, which is exactly the vocabulary the chain walkers
 * consult (`walker/type-sources/ast-inference.ts::relationRootConst` at walk
 * time, `resolver/type-propagation.ts::activeRecordQueryReturn` at resolve time).
 * Without it a paginated chain is an UNTYPED receiver and every method called on
 * its elements is a dispatch miss — the common shape in any paginated index
 * action.
 *
 * `paginates_per` / `max_paginates_per` are the per-model CONFIG macros. They
 * declare nothing: `default_per_page` / `max_per_page` come from the Kaminari
 * concern whether or not the macro is called, and the macro's argument is an
 * integer, not a name to project. They are entries purely so the class-body
 * statement is recognised (chunker grouping + external bare-call classification)
 * — the sanctioned last-resort case of a verb with genuinely ZERO in-project
 * effect, alongside `expires_in` and friends.
 *
 * Gem-gated by `activatedBy {kaminari, kaminari-activerecord}` — the meta-gem and
 * the AR-only sub-gem people install to avoid the view helpers. `page` and `per`
 * are plausible project method names, so absent the gem the grammar must not
 * exist at all: nothing is classified, nothing is typed, and a project's own
 * `def page` keeps its edges.
 */
import { defineFrameworkVocabulary } from "./framework-module.js";

export const KAMINARI_VOCABULARY = defineFrameworkVocabulary(
  "kaminari",
  {
    paginates_per: { category: "other" },
    max_paginates_per: { category: "other" },
  },
  undefined,
  {
    activatedBy: new Set(["kaminari", "kaminari-activerecord"]),
    relationReturning: new Set(["page", "per", "padding", "without_count"]),
  },
);
