/**
 * Shared plumbing for the synthetic-corpus profiles (bd tea-rags-mcp-d77bl):
 * where the fixture lives, how its files are enumerated, and how the CLI flags
 * that reshape it are parsed.
 */

import { readdirSync } from "node:fs";
import { join, relative } from "node:path";

import type { FixtureShape } from "./ts-fixture-gen.js";

/** Scratch root the generated corpus is written to. */
export const FIXTURE_ROOT = "/tmp/tea-rags-ts-fixture";

/** Every `.ts`/`.tsx` under `src/`, repo-relative and POSIX-separated, sorted. */
export function collectProjectFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(relative(root, abs));
    }
  };
  walk(join(root, "src"));
  return out.sort();
}

export interface ShapeArgs {
  shape: FixtureShape;
  /** Entries to profile, or `null` for the whole corpus. */
  entryLimit: number | null;
}

/** `--features N`, `--components N`, `--no-barrels`, `--entries N`. */
export function parseShapeArgs(argv: string[], base: FixtureShape): ShapeArgs {
  const shape: FixtureShape = { ...base };
  let entryLimit: number | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--no-barrels") shape.useBarrels = false;
    else if (arg === "--features") shape.features = Number(argv[++i]);
    else if (arg === "--components") shape.componentsPerFeature = Number(argv[++i]);
    else if (arg === "--cross") shape.crossFeatureImports = Number(argv[++i]);
    else if (arg === "--entries") entryLimit = Number(argv[++i]);
  }
  return { shape, entryLimit };
}
