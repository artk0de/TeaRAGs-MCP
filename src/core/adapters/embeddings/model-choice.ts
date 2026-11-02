// Copyright (c) 2026 Arthur Korochansky
// SPDX-License-Identifier: MIT

/**
 * Language → embedding model, the installer's table (spec "Language → model").
 * Rules run in order, first match wins; a rule whose model has no published
 * GGUF falls through to CodeRankEmbed, the next-best measured model.
 */

import { EMBEDDING_MODEL_CATALOG, type EmbeddingModelCatalogEntry } from "./model-catalog.js";

/** Ruby share of code LOC from which CodeRankEmbed wins (Ruby is in its training set). */
export const RUBY_SHARE_THRESHOLD = 0.05;
/** Swift share of code LOC from which CodeRankEmbed wins (measured best on Swift). */
export const SWIFT_SHARE_THRESHOLD = 0.05;
/** Share of code LOC in Muninn-trained languages from which Muninn-small wins. */
export const MUNINN_COVERAGE_THRESHOLD = 0.8;

const CODERANKEMBED_ID = "nomic-ai/CodeRankEmbed";
const MUNINN_ID = "brokkai/Muninn-small";
const JINA_ID = "jinaai/jina-embeddings-v2-base-code";

/** The chosen model and the human-readable rule that chose it. */
export interface EmbeddingModelChoice {
  model: EmbeddingModelCatalogEntry;
  rule: string;
}

function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

function requireEntry(catalog: readonly EmbeddingModelCatalogEntry[], id: string): EmbeddingModelCatalogEntry {
  const entry = catalog.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`Embedding model catalog has no entry for ${id}`);
  return entry;
}

/**
 * `shares`: language → fraction of code LOC (sums to ≤ 1). Rules in spec order;
 * a rule whose model has `gguf === null` falls through to CodeRankEmbed.
 */
export function selectEmbeddingModelForLanguages(
  shares: Readonly<Record<string, number>>,
  catalog: readonly EmbeddingModelCatalogEntry[] = EMBEDDING_MODEL_CATALOG,
): EmbeddingModelChoice {
  const codeRankEmbed = requireEntry(catalog, CODERANKEMBED_ID);
  const ruby = shares.ruby ?? 0;
  if (ruby >= RUBY_SHARE_THRESHOLD) {
    return { model: codeRankEmbed, rule: `ruby ${percent(ruby)} ≥ ${percent(RUBY_SHARE_THRESHOLD)}` };
  }
  const swift = shares.swift ?? 0;
  if (swift >= SWIFT_SHARE_THRESHOLD) {
    return { model: codeRankEmbed, rule: `swift ${percent(swift)} ≥ ${percent(SWIFT_SHARE_THRESHOLD)}` };
  }

  const muninn = requireEntry(catalog, MUNINN_ID);
  const covered = new Set(muninn.trainedLanguages);
  const coverage = Object.entries(shares).reduce(
    (sum, [language, share]) => sum + (covered.has(language) ? share : 0),
    0,
  );
  if (coverage >= MUNINN_COVERAGE_THRESHOLD) {
    const rule = `Muninn-trained languages ${percent(coverage)} ≥ ${percent(MUNINN_COVERAGE_THRESHOLD)}`;
    if (muninn.gguf !== null) return { model: muninn, rule };
    return { model: codeRankEmbed, rule: `${rule}; Muninn-small GGUF not published → CodeRankEmbed` };
  }

  return { model: requireEntry(catalog, JINA_ID), rule: "otherwise → jina (widest language coverage)" };
}
