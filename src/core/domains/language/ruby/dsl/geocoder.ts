/**
 * Geocoder gem. `geocoded_by :address` and `reverse_geocoded_by :lat, :lng`
 * declare a FIXED instance method each, INDEPENDENT of the operand: the operand
 * names the SOURCE column(s) the geocoding reads/writes, but the declared method
 * name is constant.
 *
 *   geocoded_by :col          → geocode          (forward geocode: address → coords)
 *   reverse_geocoded_by :a,:b → reverse_geocode  (reverse geocode: coords → address)
 *
 * Modelled with the operand-less `declaresFixed` facet — the operand symbol is
 * NOT projected into the method name (contrast `attr_accessor :x` → `x`). Kept
 * CONSERVATIVE to the two entrypoints Geocoder always defines; distance/near
 * scopes are class-level and conditional, so omitted.
 *
 * Gem-gated by `activatedBy {geocoder}`.
 */
import { defineFrameworkVocabulary } from "./framework-module.js";

export const GEOCODER_VOCABULARY = defineFrameworkVocabulary(
  "geocoder",
  {
    geocoded_by: { category: "dynamic-method", declaresFixed: [{ name: "geocode", kind: "instance" }] },
    reverse_geocoded_by: {
      category: "dynamic-method",
      declaresFixed: [{ name: "reverse_geocode", kind: "instance" }],
    },
  },
  undefined,
  { activatedBy: new Set(["geocoder"]) },
);
