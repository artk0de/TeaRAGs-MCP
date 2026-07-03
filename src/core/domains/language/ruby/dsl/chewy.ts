/**
 * Chewy (Elasticsearch index DSL) grammar. An EXTERNAL vocabulary: a bare
 * `crutch`/`template`/`agg`/`update_index` inside a `Chewy::Index` definition
 * targets the gem's index-builder runtime, not an in-project method — honestly
 * external (excluded from the resolveSuccessRate denominator, not a resolver miss).
 *
 * SAFE-SUBSET, empirically curated (bd tea-rags-mcp-adx5p.9). Chewy's surface
 * (field, index, root, template, crutch, agg, filter, update_index) overlaps
 * ubiquitous names that would steal real in-project edges if classified external:
 *
 *   KEPT:    crutch, template, agg, update_index  (chewy-specific)
 *   DROPPED: field, index, filter (ubiquitous — `def index` is on every Rails
 *            controller); root (already owned unconditionally by the routing
 *            vocabulary — no need to re-declare, and it must stay unconditional).
 *
 * Gem-gated by `activatedBy`; pure external names → `runtimeBuiltins`, no `entries`.
 */
import { defineFrameworkVocabulary } from "./framework-module.js";

export const CHEWY_VOCABULARY = defineFrameworkVocabulary(
  "chewy",
  {},
  new Set(["crutch", "template", "agg", "update_index"]),
  {
    activatedBy: new Set(["chewy"]),
  },
);
