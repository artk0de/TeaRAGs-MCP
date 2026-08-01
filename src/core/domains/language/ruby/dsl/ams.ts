/**
 * active_model_serializers grammar. Unlike dry/chewy this vocabulary EMITS rather
 * than classifies-external: `attributes :id, :name` in a serializer declares that
 * the serialized resource is READ via `.id` / `.name`. When the serializer defines
 * a custom attribute method (`def full_name; object.first + object.last; end`),
 * the reconstructed bare-receiver read resolves onto it — a real in-project edge
 * the static graph otherwise misses (AMS reads the attribute out of band).
 *
 * Only `attributes` (plural) is owned here. The singular `attribute` and the
 * association macros (`has_many` / `has_one` / `belongs_to`) are already declared
 * by the unconditional Rails vocabulary — redefining them would trip the
 * catalogue's duplicate-keyword guard, and the associations already emit
 * `model-constant-ref` edges to the associated model. So AMS adds exactly the one
 * serializer-specific keyword Rails does not cover.
 *
 * `emits: "serialized-attribute"` drives `walker/walker.ts::emitDslEdges` to push
 * one `{receiver:null, member:sym}` read per leading attribute symbol — the same
 * bare-receiver shape a callback self-send uses, so an in-project custom method is
 * resolved onto the serializer.
 *
 * A PASS-THROUGH attribute — one the serializer does NOT define — is served from
 * the MODEL, which the serializer names by convention: AMS looks a resource's
 * serializer up as `<Model>Serializer`, so `UserSerializer` reads `User#id`. The
 * interpreter emits that second `{receiver:<Model>, member:sym}` edge only when
 * the enclosing class defines no `def sym`, which is exactly AMS's own precedence
 * — a serializer method always wins — so no edge is ever fabricated for an
 * attribute the serializer implements itself (adx5p.9). Gem-gated by `activatedBy`.
 */
import { defineFrameworkVocabulary } from "./framework-module.js";

export const AMS_VOCABULARY = defineFrameworkVocabulary(
  "active_model_serializers",
  { attributes: { category: "accessor", emits: "serialized-attribute" } },
  undefined,
  { activatedBy: new Set(["active_model_serializers"]) },
);
