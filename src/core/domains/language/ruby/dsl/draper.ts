/**
 * Draper decorator gem grammar (bd tea-rags-mcp-adx5p.9).
 *
 * A decorator wraps exactly one model and exposes it as `object` / `model`;
 * `delegate_all` opts the class into forwarding every method it does not define
 * to that wrapped instance. Both facts are DELEGATION statements — "calls made
 * here land on the decorated model" — and the model is named either by the class
 * (`UserDecorator` → `User`) or explicitly by `decorates :article`.
 *
 * The delegation target is a TYPE fact, not an edge: which methods forward is
 * decided at runtime by `method_missing`, but the receiver's class is knowable
 * statically. So the grammar's interpreter is
 * `walker/type-sources/draper.ts`, which emits the `object` / `model` return
 * types; the decorator-name → model-name convention lives there with the other
 * convention strings (Pundit's `Policy` suffix, routing's `Controller` suffix),
 * keeping `dsl/` pure data.
 *
 * `decorates_association :author` DECLARES the accessor the decorator gains, so
 * a call to it resolves onto a real symbol instead of dangling. It deliberately
 * does NOT emit `model-constant-ref`: that shape is coupled to the ActiveRecord
 * association macro set (walker-emits parity), and what draper references is the
 * association's DECORATOR, not the model.
 */
import { defineFrameworkVocabulary } from "./framework-module.js";
import type { RubyDslEntry } from "./types.js";

/** `decorates_association :author` → the decorator gains an `author` reader. */
const decoratedAssociation: RubyDslEntry = {
  category: "association",
  declares: (base) => [{ name: base, kind: "instance" }],
};

export const DRAPER_VOCABULARY = defineFrameworkVocabulary(
  "draper",
  {
    delegate_all: { category: "delegation" },
    decorates: { category: "other", operands: "first-symbol" },
    decorates_association: { ...decoratedAssociation, operands: "first-symbol" },
    decorates_associations: decoratedAssociation,
  },
  undefined,
  { activatedBy: new Set(["draper"]) },
);
