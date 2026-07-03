/**
 * PaperTrail versioning gem. `has_paper_trail` declares a FIXED set of instance
 * methods on the versioned model, INDEPENDENT of any operand — the macro's
 * arguments (`on:`, `only:`, `ignore:`, …) tune WHICH changes are tracked, not
 * the method names. Every versioned model gains:
 *
 *   versions      — the `has_many :versions` reflection (the version history)
 *   version_at    — reify the record's state at a given timestamp
 *   paper_trail   — the per-record PaperTrail::Record proxy (originator, …)
 *
 * Modelled with the operand-less `declaresFixed` facet (not `declares`, which
 * projects names from a parsed symbol): `has_paper_trail` takes no naming symbol,
 * so there is nothing to project — the three names are constant. Kept CONSERVATIVE
 * to methods PaperTrail always defines; the version-limit / class-level helpers
 * are conditional and deliberately omitted.
 *
 * Gem-gated by `activatedBy {paper_trail}`: absent the gem, an unrelated
 * `has_paper_trail` (vanishingly unlikely) synthesises nothing.
 */
import { defineFrameworkVocabulary } from "./framework-module.js";

export const PAPER_TRAIL_VOCABULARY = defineFrameworkVocabulary(
  "paper_trail",
  {
    has_paper_trail: {
      category: "dynamic-method",
      declaresFixed: [
        { name: "versions", kind: "instance" },
        { name: "version_at", kind: "instance" },
        { name: "paper_trail", kind: "instance" },
      ],
    },
  },
  undefined,
  { activatedBy: new Set(["paper_trail"]) },
);
