/**
 * Devise authentication gem grammar (bd tea-rags-mcp-adx5p.9).
 *
 * Devise's central convention is a RECEIVER-NAME one: for every declared scope
 * it defines `current_<scope>` on controllers, helpers and views, returning an
 * instance of the scope's model. `current_user.admin?` is a `User#admin?` call,
 * but nothing in the calling file declares `current_user`, so every fact channel
 * the type engine consults comes back empty and the receiver stays untyped.
 *
 * The `instanceReceiverPrefixes` facet states the convention as DATA — a receiver
 * named `current_<scope>` is an instance of `camelize(scope)`. The interpreter is
 * `resolver/type-propagation.ts::nullaryReceiverType`, which applies it only
 * after every declared fact has been asked (an app that defines its own
 * `current_user` returning something else keeps its declared type) and only when
 * the derived model is a class the project actually defines.
 *
 * Scopes are derived by CONVENTION, not from the `devise_for :users` routing call
 * or the model's `devise :database_authenticatable` macro. Both live in a
 * different file from the call site, and the walker is per-file — a run-global
 * scope registry is a separate mechanism, not a prerequisite for the convention,
 * which holds for every scope devise generates. The symbol-table existence gate
 * is what keeps a non-scope `current_*` method from being typed.
 *
 * `devise` (the model macro) is an entry so the class-body declaration is a known
 * gem verb rather than an unresolved bare call. The routing verbs `devise_for` /
 * `devise_scope` / `authenticated` / `unauthenticated` are deliberately ABSENT —
 * `action-dispatch-routing.ts` already owns them and the dup-key guard forbids
 * two owners.
 */
import { defineFrameworkVocabulary } from "./framework-module.js";

export const DEVISE_VOCABULARY = defineFrameworkVocabulary(
  "devise",
  { devise: { category: "other" } },
  undefined,
  {
    activatedBy: new Set(["devise"]),
    instanceReceiverPrefixes: new Set(["current_"]),
  },
);
