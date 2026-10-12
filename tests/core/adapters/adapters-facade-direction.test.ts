/**
 * Import-direction pin for the adapters component facades.
 *
 * `adapters/filesystem` consumes the vcs adapter only through its facade
 * (`src/core/adapters/vcs/index.ts`) — files under `vcs/git/` are internal to
 * that adapter (bd tea-rags-mcp-89k7k.35, wave E).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../../");
const FILESYSTEM_DIR = join(ROOT, "src/core/adapters/filesystem");
const VCS_DIR = join(ROOT, "src/core/adapters/vcs");
const VCS_FACADE = join(VCS_DIR, "index.ts");

function tsFilesUnder(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) tsFilesUnder(abs, acc);
    else if (entry.endsWith(".ts")) acc.push(abs);
  }
  return acc;
}

/** Resolved absolute targets of every relative module specifier in a file (static, re-export, dynamic, type). */
function relativeTargets(file: string): string[] {
  const text = readFileSync(file, "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const targets: string[] = [];
  const pattern = /(?:from\s*|import\s*\(\s*|import\s+)"(\.{1,2}\/[^"]+)"/g;
  for (const match of text.matchAll(pattern)) {
    targets.push(resolve(dirname(file), match[1]).replace(/\.js$/, ".ts"));
  }
  return targets;
}

const rel = (abs: string): string => relative(ROOT, abs);

describe("adapters/filesystem never imports past the vcs facade", () => {
  it("has adapters/filesystem populated", () => {
    expect(tsFilesUnder(FILESYSTEM_DIR).length).toBeGreaterThan(0);
  });

  it("no file under adapters/filesystem/ reaches vcs except through vcs/index.ts", () => {
    const offenders: string[] = [];
    for (const file of tsFilesUnder(FILESYSTEM_DIR)) {
      for (const target of relativeTargets(file)) {
        const insideVcs = target === VCS_DIR || target.startsWith(`${VCS_DIR}/`);
        if (insideVcs && target !== VCS_FACADE) offenders.push(`${rel(file)} -> ${rel(target)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
