/**
 * Rails routing DSL (`ActionDispatch::Routing::Mapper`) — the verbs drawn bare
 * in `config/routes*`. Two grammar facets (bd tea-rags-mcp-n2kpz):
 *
 *   - HTTP verbs with a `to:` target (`get "/x", to: "posts#index"`, `root
 *     "home#index"`) EMIT the routed edge `routes → <Ns::>Controller#action` via
 *     the `route-action` shape. The `to:` path self-encodes the namespace
 *     (`admin/settings#show` → `Admin::SettingsController#show`), so no
 *     enclosing-block tracking is needed.
 *   - The scoping / config verbs (`namespace`, `resources`, `collection`, …) are
 *     pure ActionDispatch runtime calls with NO in-project target — genuine
 *     external names (like `render`/`params`): they only leave the recall
 *     denominator, they synthesise nothing.
 *
 * `scope` is DELIBERATELY ABSENT — it is already an unconditional Rails entry
 * (ActiveRecord named scope) in `rails.ts`; the dup-key guard forbids two owners.
 * `resources :posts`'s IMPLICIT controller mapping (no `to:`) needs the enclosing
 * `namespace` block and is deferred.
 */
import { defineFrameworkVocabulary } from "./framework-module.js";
import type { RubyDslEntry } from "./types.js";

const routeAction: RubyDslEntry = { category: "other", emits: "route-action" };
const scoping: RubyDslEntry = { category: "other" };

const ROUTING_ENTRIES: Record<string, RubyDslEntry> = {
  // HTTP verbs + root — emit the routed controller#action edge from `to:` / string.
  get: routeAction,
  post: routeAction,
  put: routeAction,
  patch: routeAction,
  delete: routeAction,
  match: routeAction,
  root: routeAction,
  // Scoping / config — external ActionDispatch calls, no in-project target.
  namespace: scoping,
  resources: scoping,
  resource: scoping,
  collection: scoping,
  member: scoping,
  constraints: scoping,
  mount: scoping,
  direct: scoping,
  resolve: scoping,
  draw: scoping,
  concern: scoping,
  devise_for: scoping,
  devise_scope: scoping,
  authenticated: scoping,
  unauthenticated: scoping,
  redirect: scoping,
};

export const ROUTING_VOCABULARY = defineFrameworkVocabulary("action-dispatch-routing", ROUTING_ENTRIES);
