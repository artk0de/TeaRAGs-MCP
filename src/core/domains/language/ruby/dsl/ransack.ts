/**
 * Ransack search gem. The canonical idiom is a two-verb chain off the model:
 *
 *   Post.ransack(params[:q]).result            → an AR::Relation of Post
 *   Post.ransack(params[:q]).result(distinct:) → same, deduped
 *
 * Both links are `relationReturning` so the chain walkers thread it end to end
 * and the search result carries the model as its ELEMENT type — without them the
 * whole chain is an untyped receiver and every method called on what it yields is
 * a dispatch miss.
 *
 * MODELLING COMPROMISE, stated plainly: `ransack` alone actually returns a
 * `Ransack::Search`, not a relation. The facet has no "search object" form, and
 * the two verbs are only useful together — the value is the FUSED
 * `Const.ransack(…).result` chain, which the walk-time chain walker resolves in
 * one pass. Splitting the pair would leave the common form untyped, so both are
 * in. The cost is that a lone `q = Post.ransack(…)` binds a container of Post
 * rather than a Search; nothing downstream of that binding (`.result` is not a
 * container-element verb) fabricates an edge from it.
 *
 * `ransacker :full_name do … end` declares NO method — it registers a custom
 * search attribute in the model's `.ransackers` hash, and its block builds Arel,
 * not a reader. Entry purely for class-body recognition, like kaminari's
 * `paginates_per`.
 *
 * The allowlist hooks (`ransackable_attributes`, `ransackable_associations`,
 * `ransackable_scopes`, `ransortable_attributes`) are deliberately ABSENT.
 * Ransack 4 requires the APPLICATION to define them as `def self.…`, so they are
 * in-project source: classifying them external would steal the edge from the very
 * definition that answers the call.
 *
 * Gem-gated by `activatedBy {ransack}` — `result` is a plausible project method
 * name, so absent the gem the grammar must not exist at all.
 */
import { defineFrameworkVocabulary } from "./framework-module.js";

export const RANSACK_VOCABULARY = defineFrameworkVocabulary(
  "ransack",
  { ransacker: { category: "other" } },
  undefined,
  {
    activatedBy: new Set(["ransack"]),
    relationReturning: new Set(["ransack", "result"]),
  },
);
