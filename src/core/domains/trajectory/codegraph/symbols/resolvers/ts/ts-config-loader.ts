/**
 * Loads `compilerOptions.{baseUrl, paths}` from the repository's
 * `tsconfig.json`. Tolerates JSONC comments (the JSON5/JSONC parser is
 * not pulled in for slice 1 — a naïve comment strip is sufficient for
 * the conventional tsconfig shapes the resolver cares about). Returns
 * empty defaults on any failure.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { TsCompilerOptions } from "./ts-path-mapper.js";

export function loadTsConfig(repoRoot: string): TsCompilerOptions {
  const path = join(repoRoot, "tsconfig.json");
  if (!existsSync(path)) return { baseUrl: ".", paths: {} };
  try {
    const raw = readFileSync(path, "utf8");
    const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const parsed = JSON.parse(stripped) as {
      compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
    };
    const co = parsed.compilerOptions ?? {};
    return { baseUrl: co.baseUrl ?? ".", paths: co.paths ?? {} };
  } catch {
    return { baseUrl: ".", paths: {} };
  }
}
