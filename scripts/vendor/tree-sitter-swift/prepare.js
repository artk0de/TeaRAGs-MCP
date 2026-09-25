#!/usr/bin/env node

/**
 * Stage the `@artk0de/tree-sitter-swift` package sources in a directory.
 *
 * Upstream tagged tree-sitter-swift 0.7.3 on GitHub but never published it to
 * npm (latest there is 0.7.1), and 0.7.3 is the release that parses
 * `@unchecked Sendable`, `#if` inside a type body and `nonisolated(unsafe)`.
 * This script downloads the upstream release asset, verifies it against the
 * pinned digest, and rewrites the two files that stop it from installing as a
 * prebuilt package:
 *
 *   - `package.json` — renamed to the fork, `tree-sitter-cli` and `which`
 *     dropped from `dependencies` (only the parser GENERATOR needs them, and a
 *     consumer of prebuilds never generates), install script reduced to
 *     `node-gyp-build`;
 *   - `binding.gyp` — the `actions` block removed, because it runs
 *     `tree-sitter generate` on every native build. The release asset already
 *     carries the generated `src/`, and 0.7.1 as published has no such block.
 *
 * Nothing else changes: `src/`, `grammar.js`, `queries/` and the node binding
 * are byte-identical to the release asset.
 *
 * Usage: node scripts/vendor/tree-sitter-swift/prepare.js <out-dir>
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const UPSTREAM_VERSION = "0.7.3";
const FORK_VERSION = `${UPSTREAM_VERSION}-prebuild.1`;
const ASSET_URL = `https://github.com/alex-pinkus/tree-sitter-swift/releases/download/${UPSTREAM_VERSION}/tree-sitter-swift.tar.gz`;
const ASSET_SHA256 = "c595b41459b0816f246ec27f60e08392ff453135e12ef47a1852ed37fe6705fe";

const outDir = process.argv[2];
if (!outDir) {
  console.error("usage: node prepare.js <out-dir>");
  process.exit(2);
}
const out = resolve(outDir);

const response = await fetch(ASSET_URL);
if (!response.ok) throw new Error(`download failed: ${response.status} ${ASSET_URL}`);
const tarball = Buffer.from(await response.arrayBuffer());
const digest = createHash("sha256").update(tarball).digest("hex");
if (digest !== ASSET_SHA256) {
  throw new Error(`release asset digest ${digest} does not match the pinned ${ASSET_SHA256}`);
}

if (existsSync(out)) rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const tarPath = join(out, "..", `tree-sitter-swift-${UPSTREAM_VERSION}.tar.gz`);
writeFileSync(tarPath, tarball);
execFileSync("tar", ["-xzf", tarPath, "-C", out], { stdio: "inherit" });
rmSync(tarPath);

const pkgPath = join(out, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
if (pkg.version !== UPSTREAM_VERSION) {
  throw new Error(`expected upstream version ${UPSTREAM_VERSION}, found ${pkg.version}`);
}
pkg.name = "@artk0de/tree-sitter-swift";
pkg.version = FORK_VERSION;
pkg.description = `tree-sitter-swift ${UPSTREAM_VERSION} (unpublished upstream) with N-API prebuilds.`;
pkg.scripts = {
  install: "node-gyp-build",
  prebuildify: "prebuildify --napi --strip",
  test: "node --test bindings/node/*_test.js",
};
delete pkg.dependencies["tree-sitter-cli"];
delete pkg.dependencies.which;
pkg.devDependencies = { "node-gyp": "^10.0.1", prebuildify: "^6.0.0" };
// Upstream spells the meta key `tree_sitter`, so the peer it meant as optional
// is enforced; the runtime this package is loaded by is `tree-sitter` 0.25.
pkg.peerDependencies = { "tree-sitter": "^0.22.1 || ^0.25.0" };
pkg.peerDependenciesMeta = { "tree-sitter": { optional: true } };
pkg.publishConfig = { access: "public" };
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

const gypPath = join(out, "binding.gyp");
const gyp = readFileSync(gypPath, "utf8");
const start = gyp.indexOf('"actions"');
if (start !== -1) {
  const open = gyp.indexOf("[", start);
  let depth = 0;
  let end = open;
  for (; end < gyp.length; end++) {
    if (gyp[end] === "[") depth++;
    else if (gyp[end] === "]" && --depth === 0) break;
  }
  const head = gyp.slice(0, start).trimEnd();
  const tail = gyp.slice(end + 1).replace(/^\s*,?\s*/, "");
  writeFileSync(gypPath, `${head}\n    ${tail}`);
}

console.log(`staged @artk0de/tree-sitter-swift@${FORK_VERSION} in ${out}`);
