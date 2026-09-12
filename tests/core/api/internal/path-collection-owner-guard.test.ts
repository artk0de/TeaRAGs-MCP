/**
 * bd tea-rags-mcp-dxa9w — one owner for "which collection does this PATH mean".
 *
 * A collection's identity has two possible sources: the deterministic path hash
 * (`resolveCollectionName`) and the project registry, which re-points an entry
 * at a new path when a project moves (`ProjectRegistryOps#register` →
 * `CollectionRegistry#updatePath`). Once the two disagree, whichever rule a call
 * site happens to carry decides what it operates on: the index run built a fresh
 * `code_<hash(newPath)>` while the registered collection kept the data, status
 * read "not indexed" at both the path and the alias, and prime printed the same.
 *
 * `resolveCollection` / `createPathCollectionResolver` is the single choice
 * point — registry entry first, hash only for a path nothing claims. This guard
 * is what makes it the ONLY one: a comment cannot stop the next caller from
 * hashing a path, and nothing about hashing a path fails a test on its own.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../../src");

/**
 * The only files allowed to derive a collection name from a path by hashing it.
 * One line each, saying why the hash is the right rule THERE. Everything else
 * resolves through `createPathCollectionResolver` / `resolveCollection`.
 */
const ALLOWED = [
  // Defines the hash, and packages the registry-free fallback every layer shares.
  "core/infra/collection-name.ts",
  // The owner: registry entry first, the hash only as its fallback.
  "core/api/internal/collection-resolver.ts",
  // `register` CREATES the identity for a path the registry does not claim yet.
  "core/api/internal/ops/project-registry-ops.ts",
  // `create` CREATES the identity of a brand-new worktree clone's collection.
  "core/domains/maintenance/worktree/worktree-provisioner.ts",
];

/** The call itself, in any spelling the formatter can produce. */
const HASH_CALL = /resolveCollectionName\s*\(/g;

function listSourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listSourceFiles(full));
    else if (entry.name.endsWith(".ts")) found.push(full);
  }
  return found;
}

/** Every hash-the-path call in one file's text. */
function findHashCallsIn(source: string): string[] {
  return [...source.matchAll(HASH_CALL)].map((hit) => hit[0]);
}

function findOffenders(): string[] {
  const allowed = new Set(ALLOWED.map((p) => p.split("/").join(sep)));
  const offenders: string[] = [];
  for (const file of listSourceFiles(SRC_DIR)) {
    const rel = relative(SRC_DIR, file);
    if (allowed.has(rel)) continue;
    for (const hit of findHashCallsIn(readFileSync(file, "utf8"))) {
      offenders.push(`${rel}: ${hit}`);
    }
  }
  return offenders;
}

describe("a path becomes a collection through one owner", () => {
  it("finds no direct path-hash outside the allowlist", () => {
    // The message is the fix: the named file must take the collection from
    // `createPathCollectionResolver(registry)` (or `resolveCollection`), which
    // still hashes when no registry entry claims the path.
    expect(findOffenders()).toEqual([]);
  });

  // A guard nobody has seen fail is a guard nobody knows works.
  it("recognizes the call in the spellings real source takes", () => {
    const offenders = [
      `const collectionName = resolveCollectionName(absolutePath);`,
      `return resolveCollectionName (request.path);`,
      `registry.get(resolveCollectionName(await validatePath(path)))`,
      `resolveCollectionName(\n  absolutePath,\n)`,
    ];
    for (const source of offenders) {
      expect(findHashCallsIn(source), source).not.toEqual([]);
    }
  });

  it("passes the shapes that are not a derivation", () => {
    const allowed = [
      `import { resolveCollectionName, validatePath } from "./collection-name.js";`,
      `export { resolveCollectionName } from "../../infra/collection-name.js";`,
      `// resolved the way resolveCollectionName would resolve it`,
      `const name = resolveCollectionNameForAlias(path);`,
    ];
    for (const source of allowed) {
      expect(findHashCallsIn(source), source).toEqual([]);
    }
  });

  it("keeps the allowlist small and every entry real", () => {
    // An allowlist that drifts into "the files that happen to call it" is no
    // guard at all: each entry must still exist and still make the call.
    for (const rel of ALLOWED) {
      const source = readFileSync(join(SRC_DIR, rel), "utf8");
      expect(findHashCallsIn(source), rel).not.toEqual([]);
    }
    expect(ALLOWED).toHaveLength(4);
  });
});
