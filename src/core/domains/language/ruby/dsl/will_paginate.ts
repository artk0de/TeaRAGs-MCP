/**
 * will_paginate — kaminari's older sibling, and the same shape of contribution:
 * three scopes grafted onto `ActiveRecord::Relation`, none of them a declaring
 * macro.
 *
 *   Post.paginate(page: 1, per_page: 20)   → a relation of Post
 *   Post.page(2).per_page(10)              → the same relation, chained form
 *
 * All three enter `relationReturning`, so a paginated chain keeps the model as
 * its element type instead of degrading to an untyped receiver. `page` is shared
 * with the kaminari vocabulary — the facet is a UNION fold, so a project on
 * either gem (the normal case; the two are alternatives, not companions) types
 * the chain, and a project on neither types nothing.
 *
 * This vocabulary contributes NO `entries`. will_paginate's per-model default is
 * written `self.per_page = 25` — an assignment node, not a macro call — so there
 * is no class-body statement to recognise and nothing to classify. Contrast
 * kaminari, whose `paginates_per 25` IS a call and therefore needs an entry.
 *
 * Gem-gated by `activatedBy {will_paginate}`: `paginate` / `page` / `per_page`
 * are all plausible project method names, so absent the gem the grammar must not
 * exist at all.
 */
import { defineFrameworkVocabulary } from "./framework-module.js";

export const WILL_PAGINATE_VOCABULARY = defineFrameworkVocabulary("will_paginate", {}, undefined, {
  activatedBy: new Set(["will_paginate"]),
  relationReturning: new Set(["paginate", "page", "per_page"]),
});
