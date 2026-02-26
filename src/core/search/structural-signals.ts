/**
 * Structural derived signal descriptors -- signals derived from payload
 * structure, not from any trajectory provider. Built-in to the Reranker.
 */
import type { DerivedSignalDescriptor } from "../contracts/types/reranker.js";

function normalize(value: number, max: number): number {
  if (max <= 0) return 0;
  return Math.min(1, Math.max(0, value / max));
}

const RISKY_PATH_PATTERNS = [
  "auth",
  "security",
  "crypto",
  "password",
  "secret",
  "token",
  "credential",
  "permission",
  "access",
];

export const structuralSignals: DerivedSignalDescriptor[] = [
  {
    name: "similarity",
    description: "Base semantic similarity score from vector search",
    sources: [],
    extract(payload) {
      return (payload._score as number) ?? (payload.score as number) ?? 0;
    },
  },
  {
    name: "chunkSize",
    description: "Normalized chunk size (endLine - startLine)",
    sources: [],
    defaultBound: 500,
    extract(payload) {
      const start = (payload.startLine as number) || 0;
      const end = (payload.endLine as number) || 0;
      return normalize(Math.max(0, end - start), 500);
    },
  },
  {
    name: "documentation",
    description: "Documentation file boost (1 if isDocumentation, 0 otherwise)",
    sources: [],
    extract(payload) {
      return payload.isDocumentation ? 1 : 0;
    },
  },
  {
    name: "imports",
    description: "Normalized import/dependency count",
    sources: [],
    defaultBound: 20,
    extract(payload) {
      const arr = payload.imports;
      return normalize(Array.isArray(arr) ? arr.length : 0, 20);
    },
  },
  {
    name: "pathRisk",
    description: "Security-sensitive path pattern match (1 if matches, 0 otherwise)",
    sources: [],
    extract(payload) {
      const path = ((payload.relativePath as string) || "").toLowerCase();
      return RISKY_PATH_PATTERNS.some((p) => path.includes(p)) ? 1 : 0;
    },
  },
];
