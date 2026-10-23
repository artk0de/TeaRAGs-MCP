/**
 * Claude Code package generator: `plugins/<name>/` (already in the Claude Code
 * dialect) → `.claude-plugin/<name>/`, copied verbatim — bytes, executable bits
 * and symlinks kept, `.claude-plugin/plugin.json` included. The root
 * `.claude-plugin/marketplace.json` and `.claude-plugin/.benchmarks/` are not
 * packages and stay untouched.
 */

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { PLUGINS_DIR, walk } from "./harness/package.js";

/** Folder holding the generated Claude Code packages and the root marketplace manifest. */
export const CLAUDE_PACKAGES_DIR = ".claude-plugin";

/** One package entry: file bytes + mode (`0o755` / `0o644`), or a symlink target. */
export interface PackageFile {
  content: Buffer;
  mode: number;
  link?: string;
}

/** Every folder under `plugins/` that carries `.claude-plugin/plugin.json`, sorted. */
export function claudePluginNames(root: string): string[] {
  return readdirSync(join(root, PLUGINS_DIR))
    .sort()
    .filter((name) => existsSync(join(root, PLUGINS_DIR, name, ".claude-plugin/plugin.json")));
}

/** The package for `plugins/<name>/` as `path (relative to the package) → file`. */
export function renderClaudePackage(root: string, name: string): Map<string, PackageFile> {
  const src = join(root, PLUGINS_DIR, name);
  const files = new Map<string, PackageFile>();
  for (const file of walk(src)) {
    const stat = lstatSync(file);
    const path = relative(src, file);
    if (stat.isSymbolicLink()) {
      files.set(path, { content: Buffer.alloc(0), mode: 0o777, link: readlinkSync(file) });
      continue;
    }
    files.set(path, { content: readFileSync(file), mode: stat.mode & 0o111 ? 0o755 : 0o644 });
  }
  return files;
}

/** Replace every `.claude-plugin/<name>/` with a fresh copy of its source; returns the file count. */
export function writeClaudePackages(root: string): number {
  let count = 0;
  for (const name of claudePluginNames(root)) {
    const dir = join(root, CLAUDE_PACKAGES_DIR, name);
    rmSync(dir, { recursive: true, force: true });
    for (const [path, file] of renderClaudePackage(root, name)) {
      const target = join(dir, path);
      mkdirSync(dirname(target), { recursive: true });
      if (file.link !== undefined) {
        symlinkSync(file.link, target);
      } else {
        writeFileSync(target, file.content);
        chmodSync(target, file.mode);
      }
      count++;
    }
  }
  return count;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const count = writeClaudePackages(root);
  console.log(`✓ ${CLAUDE_PACKAGES_DIR}/<plugin>: ${count} files regenerated from ${PLUGINS_DIR}/.`);
}
