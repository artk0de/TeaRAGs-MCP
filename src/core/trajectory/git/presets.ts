/**
 * Git trajectory presets — reranking strategies using git-derived + structural signals.
 *
 * Each preset defines a named weight configuration over derived signal names.
 * The `relevance` preset is NOT here — it is the generic RelevancePreset
 * defined at the search layer (structural-only, no trajectory dependency).
 */

import type { RerankPreset } from "../../contracts/types/reranker.js";

export const GIT_PRESETS: RerankPreset[] = [
  // ── semantic_search presets ──

  {
    name: "techDebt",
    description: "Find legacy code with high churn, old age, and frequent bug fixes",
    tool: "semantic_search",
    weights: {
      similarity: 0.2,
      age: 0.15,
      churn: 0.15,
      bugFix: 0.15,
      volatility: 0.1,
      knowledgeSilo: 0.1,
      density: 0.1,
      blockPenalty: -0.05,
    },
  },
  {
    name: "hotspots",
    description: "Identify frequently-changing bug-prone code areas",
    tool: "semantic_search",
    weights: {
      similarity: 0.25,
      chunkChurn: 0.15,
      chunkRelativeChurn: 0.15,
      burstActivity: 0.15,
      bugFix: 0.15,
      volatility: 0.15,
      blockPenalty: -0.15,
    },
  },
  {
    name: "codeReview",
    description: "Surface recent high-activity code for review",
    tool: "semantic_search",
    weights: {
      similarity: 0.35,
      recency: 0.15,
      burstActivity: 0.15,
      density: 0.15,
      chunkChurn: 0.2,
      blockPenalty: -0.1,
    },
  },
  {
    name: "onboarding",
    description: "Documentation and stable code for new team members",
    tool: "semantic_search",
    weights: { similarity: 0.4, documentation: 0.3, stability: 0.3 },
  },
  {
    name: "securityAudit",
    description: "Old code in security-critical paths needing review",
    tool: "semantic_search",
    weights: {
      similarity: 0.3,
      age: 0.15,
      ownership: 0.1,
      bugFix: 0.15,
      pathRisk: 0.15,
      volatility: 0.15,
    },
  },
  {
    name: "refactoring",
    description: "Large, churning, volatile code — candidates for refactoring",
    tool: "semantic_search",
    weights: {
      similarity: 0.2,
      chunkChurn: 0.15,
      relativeChurnNorm: 0.15,
      chunkSize: 0.15,
      volatility: 0.15,
      bugFix: 0.1,
      age: 0.1,
      blockPenalty: -0.1,
    },
  },
  {
    name: "ownership",
    description: "Code with single dominant author — knowledge transfer risk",
    tool: "semantic_search",
    weights: { similarity: 0.4, ownership: 0.35, knowledgeSilo: 0.25 },
  },
  {
    name: "impactAnalysis",
    description: "Highly-imported modules — changes affect many dependents",
    tool: "semantic_search",
    weights: { similarity: 0.5, imports: 0.5 },
  },

  // ── search_code presets ──

  {
    name: "recent",
    description: "Boost recently modified code",
    tool: "search_code",
    weights: { similarity: 0.7, recency: 0.3 },
  },
  {
    name: "stable",
    description: "Boost low-churn stable code",
    tool: "search_code",
    weights: { similarity: 0.7, stability: 0.3 },
  },
];
