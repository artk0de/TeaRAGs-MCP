#!/usr/bin/env node
// Language/LOC profile of what tea-rags would index: `git ls-files` minus .gitignore, .contextignore
// and .contextignore.local. Usage: node profile.mjs <projectDir>
// Prints { files, loc, languages: { <lang>: { files, loc, share } }, estimatedChunks }.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Code-language subset of the indexer's extension -> language mapping
// (src/core/domains/ingest/pipeline/chunker/language-config/config.ts: LANGUAGE_MAP restricted to
// CODE_LANGUAGES). tests/plugins/tea-rags-setup/profile.test.ts fails when this table drifts.
export const EXTENSION_LANGUAGES = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".java": "java",
  ".go": "go",
  ".rs": "rust",
  ".rb": "ruby",
  ".rake": "ruby",
  ".swift": "swift",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
};

const LOC_PER_CHUNK = 30;
const IGNORE_FILES = [".gitignore", ".contextignore", ".contextignore.local"];

function git(projectDir, args) {
  return execFileSync("git", args, { cwd: projectDir, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

function splitZ(out) {
  return out.split("\0").filter(Boolean);
}

/** Tracked files minus everything the ignore files match (git does the pattern matching). */
function indexableFiles(projectDir) {
  const tracked = splitZ(git(projectDir, ["ls-files", "-z"]));
  const excludeArgs = IGNORE_FILES.filter((f) => existsSync(join(projectDir, f))).map((f) => `--exclude-from=${f}`);
  const ignored = splitZ(
    git(projectDir, ["ls-files", "-z", "--cached", "--ignored", "--exclude-standard", ...excludeArgs]),
  );
  const drop = new Set(ignored);
  return tracked.filter((f) => !drop.has(f));
}

function countLines(path) {
  const buf = readFileSync(path);
  if (buf.length === 0) return 0;
  let lines = 0;
  for (const byte of buf) if (byte === 10) lines += 1;
  return buf[buf.length - 1] === 10 ? lines : lines + 1;
}

function profile(projectDir) {
  const languages = {};
  let files = 0;
  let loc = 0;
  let estimatedChunks = 0;
  for (const rel of indexableFiles(projectDir)) {
    const language = EXTENSION_LANGUAGES[extname(rel)];
    if (!language) continue;
    const abs = join(projectDir, rel);
    if (!existsSync(abs)) continue;
    const lines = countLines(abs);
    const entry = (languages[language] ??= { files: 0, loc: 0, share: 0 });
    entry.files += 1;
    entry.loc += lines;
    files += 1;
    loc += lines;
    estimatedChunks += Math.max(1, Math.ceil(lines / LOC_PER_CHUNK));
  }
  for (const entry of Object.values(languages)) {
    entry.share = loc === 0 ? 0 : Math.round((entry.loc / loc) * 100) / 100;
  }
  return { files, loc, languages, estimatedChunks };
}

function main() {
  const arg = process.argv[2];
  const projectDir = resolve(arg ?? "");
  if (!arg || !existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
    throw new Error(`projectDir not found: ${arg ?? "(missing argument)"}`);
  }
  process.stdout.write(`${JSON.stringify(profile(projectDir))}\n`);
}

// Run only as a script; importing (the table-sync test) must not execute or exit.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ error: String(error?.message ?? error) })}\n`);
    process.exit(1);
  }
}
