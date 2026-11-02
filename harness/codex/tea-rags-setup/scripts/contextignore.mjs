#!/usr/bin/env node
// Writes/merges <projectDir>/.contextignore.local with build-output patterns for the detected stacks.
// Usage: node contextignore.mjs <projectDir>
// Prints { added: string[], kept: number }. Existing lines are never removed or reordered.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";

const HEADER = "# tea-rags install";

const STACKS = [
  {
    name: "rust",
    manifests: ["Cargo.toml"],
    extensions: [".rs"],
    patterns: ["target/"],
  },
  {
    name: "node",
    manifests: ["package.json"],
    extensions: [],
    patterns: ["node_modules/", "dist/", "build/", "coverage/", ".next/", ".nuxt/", ".svelte-kit/", ".turbo/"],
  },
  {
    name: "ruby",
    manifests: ["Gemfile"],
    extensions: [".rb"],
    patterns: ["vendor/bundle/", "public/assets/", "public/packs/", "tmp/", "log/"],
  },
  {
    name: "python",
    manifests: ["pyproject.toml", "requirements.txt", "setup.py"],
    extensions: [".py"],
    patterns: [".venv/", "__pycache__/", "*.egg-info/"],
  },
  {
    name: "swift",
    manifests: ["Package.swift"],
    extensions: [".swift"],
    patterns: [".build/", "DerivedData/", "Pods/"],
  },
  {
    name: "go",
    manifests: ["go.mod"],
    extensions: [".go"],
    patterns: ["vendor/"],
  },
];

const ALL_STACKS_PATTERNS = [
  "*.min.js",
  "*.min.css",
  "*.map",
  "*.lock",
  "package-lock.json",
  "*.generated.*",
  "*.pb.go",
  "*_pb2.py",
];

function trackedFiles(projectDir) {
  const out = execFileSync("git", ["ls-files", "-z"], {
    cwd: projectDir,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return out.split("\0").filter(Boolean);
}

function detectStacks(files) {
  const names = new Set(files.map((f) => basename(f)));
  const extensions = new Set(files.map((f) => extname(f)));
  return STACKS.filter(
    (stack) => stack.manifests.some((m) => names.has(m)) || stack.extensions.some((e) => extensions.has(e)),
  );
}

function main() {
  const projectDir = resolve(process.argv[2] ?? "");
  if (!process.argv[2] || !existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
    throw new Error(`projectDir not found: ${process.argv[2] ?? "(missing argument)"}`);
  }
  const target = join(projectDir, ".contextignore.local");
  const existing = existsSync(target) ? readFileSync(target, "utf8") : "";
  const existingLines = existing.split("\n");
  if (existingLines[existingLines.length - 1] === "") existingLines.pop();
  const known = new Set(existingLines.map((line) => line.trim()));

  const wanted = [...detectStacks(trackedFiles(projectDir)).flatMap((s) => s.patterns), ...ALL_STACKS_PATTERNS];
  const added = [...new Set(wanted)].filter((pattern) => !known.has(pattern));

  if (added.length > 0) {
    let next = existing;
    if (next !== "" && !next.endsWith("\n")) next += "\n";
    if (!known.has(HEADER)) next += `${HEADER}\n`;
    next += `${added.join("\n")}\n`;
    writeFileSync(target, next);
  }
  process.stdout.write(`${JSON.stringify({ added, kept: existingLines.length })}\n`);
}

try {
  main();
} catch (error) {
  process.stdout.write(`${JSON.stringify({ error: String(error?.message ?? error) })}\n`);
  process.exit(1);
}
