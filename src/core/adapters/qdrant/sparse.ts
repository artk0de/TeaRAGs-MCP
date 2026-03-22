/**
 * BM25 Sparse Vector Generator — stateless, code-aware.
 *
 * Generates sparse vectors for Qdrant hybrid search using:
 * - Code-aware tokenization (camelCase, snake_case, PascalCase splitting)
 * - Feature hashing (FNV-1a) for deterministic token→index mapping
 * - BM25 TF-only scoring (Qdrant applies IDF server-side via modifier:"idf")
 *
 * No vocabulary state, no training needed. Same input → same output always.
 */

import type { SparseVector } from "../qdrant/client.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HASH_SPACE = 65536; // 2^16

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "in",
  "of",
  "to",
  "and",
  "or",
  "for",
  "it",
  "this",
  "that",
  "with",
  "as",
  "by",
  "on",
  "at",
  "be",
  "are",
  "was",
  "were",
  "been",
  "has",
  "have",
  "had",
  "not",
  "but",
  "from",
  "will",
  "do",
  "if",
  "no",
  "so",
  "we",
  "he",
  "she",
  "my",
  "your",
]);

const MIN_TOKEN_LENGTH = 2;

// ---------------------------------------------------------------------------
// Code Tokenizer
// ---------------------------------------------------------------------------

/**
 * Tokenize text with code-aware splitting.
 *
 * Handles: camelCase, PascalCase, snake_case, SCREAMING_CASE,
 * dot.notation, acronyms (XMLParser → xml, parser).
 * Removes stop words and tokens shorter than 2 chars.
 */
export function codeTokenize(text: string): string[] {
  if (!text) return [];

  return (
    text
      // Split on non-alphanumeric (dots, underscores, spaces, punctuation)
      .replace(/[^a-zA-Z0-9]/g, " ")
      // Insert space before uppercase after lowercase (camelCase)
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      // Insert space between acronym and next word (XMLParser → XML Parser)
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      // Insert space at digit↔letter boundaries (retry3Times → retry 3 Times)
      .replace(/([a-zA-Z])(\d)/g, "$1 $2")
      .replace(/(\d)([a-zA-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length >= MIN_TOKEN_LENGTH && !STOP_WORDS.has(t))
  );
}

// ---------------------------------------------------------------------------
// Feature Hashing (FNV-1a)
// ---------------------------------------------------------------------------

const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;

/**
 * Deterministic hash: token → index in [0, HASH_SPACE).
 * Uses FNV-1a for good distribution with minimal code.
 */
export function featureHash(token: string): number {
  let hash = FNV_OFFSET;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return (hash >>> 0) & (HASH_SPACE - 1);
}

// ---------------------------------------------------------------------------
// Sparse Vector Generator
// ---------------------------------------------------------------------------

/**
 * Generate a BM25 TF-only sparse vector for text.
 *
 * Stateless: same input always produces same output regardless of context.
 * IDF is NOT applied — Qdrant handles it server-side via collection modifier:"idf".
 *
 * @param text - Code content or query string
 * @param k1 - BM25 term saturation parameter (default 1.2)
 * @param b - BM25 length normalization parameter (default 0.75)
 * @param avgDocLength - Average document length in tokens (default 50)
 */
export function generateSparseVector(text: string, k1 = 1.2, b = 0.75, avgDocLength = 50): SparseVector {
  const tokens = codeTokenize(text);
  if (tokens.length === 0) return { indices: [], values: [] };

  // Accumulate term frequency per hash bucket
  const bucketFreq = new Map<number, number>();
  for (const token of tokens) {
    const bucket = featureHash(token);
    bucketFreq.set(bucket, (bucketFreq.get(bucket) ?? 0) + 1);
  }

  const docLength = tokens.length;
  const indices: number[] = [];
  const values: number[] = [];

  for (const [bucket, freq] of bucketFreq) {
    // BM25 TF component only (no IDF — Qdrant applies it server-side)
    const tf = (freq * (k1 + 1)) / (freq + k1 * (1 - b + b * (docLength / avgDocLength)));
    indices.push(bucket);
    values.push(tf);
  }

  return { indices, values };
}

// ---------------------------------------------------------------------------
// Backward-compatible class wrapper
// ---------------------------------------------------------------------------

/**
 * @deprecated Use `generateSparseVector()` directly.
 * Kept for backward compatibility at call sites.
 */
export class BM25SparseVectorGenerator {
  static generateSimple(text: string): SparseVector {
    return generateSparseVector(text);
  }
}
