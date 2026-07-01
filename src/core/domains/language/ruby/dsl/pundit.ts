/**
 * Pundit authorization gem grammar. `authorize :relay, :update?` (or
 * `authorize @record, :update?`) dispatches at runtime to
 * `[Namespace::]<Record>Policy#<query || action_name>?` — Pundit looks up the
 * policy class and instantiates it out of band, so the static graph never sees
 * the controller → policy edge. The `policy-dispatch` emit reconstructs it (bd
 * tea-rags-mcp-n2kpz): the walker's `emitDslEdges` derives the policy constant
 * from the first arg (symbol → `<Camelize>Policy`, `[:admin, :x]` array →
 * `Admin::XPolicy`) and the method from the query symbol.
 *
 * `authorize` is a gem instance method with no in-project `def`, so it is also a
 * legitimate `entries` external name (like `before_action`); the emit is the
 * grammar that adds the real edge. A gem gets its own module (ruby-dsl.md).
 */
import { defineFrameworkVocabulary } from "./framework-module.js";

export const PUNDIT_VOCABULARY = defineFrameworkVocabulary("pundit", {
  authorize: { category: "other", emits: "policy-dispatch" },
});
