/**
 * Rust files that are test code by DECLARATION (bd tea-rags-mcp-52wk3.10).
 *
 * `#[cfg(test)] mod testutil;` in `lib.rs` makes the separate file
 * `testutil.rs` compile only in the test build, and nothing inside that file
 * says so. This reads the declarations and names the files they reach:
 *
 *   - a body-less `mod x;` that is test-only (`isInlineTestNode`), or nested in
 *     a test-only inline module, or in a file whose root is `#![cfg(test)]`;
 *   - every body-less `mod x;` of a file already named — a module declared
 *     from test code is test code — iterated to a fixpoint (the set only
 *     grows, so a cycle of declarations terminates).
 *
 * Resolution follows the Rust reference: a declaration in a mod-rs file
 * (`mod.rs`, `lib.rs`, `main.rs`, a crate root by location or by a run
 * `Cargo.toml` target `path`) resolves under that file's
 * directory, in any other file under `<dir>/<stem>/`; inline modules append
 * their names; the child is `x.rs`, else `x/mod.rs`. `#[path = "p"]` is
 * relative to the file's directory at file level and to the module directory
 * plus the inline path inside inline modules. Only paths of the run's file list
 * are answered. `cfg_attr`-driven paths are out of scope.
 *
 * A text prefilter keeps the parse to files that can declare one: only a file
 * holding a body-less `mod` is read twice, and only one that also mentions
 * `cfg(` is parsed before the closure reaches it.
 */

import { posix } from "node:path";

import type { AstNode } from "../../../contracts/types/ast.js";
import type { DeclaredTestFileQuery, DeclaredTestFileSource } from "../../../contracts/types/language.js";
import { loadRustSourceParser, type RustSourceParserLoader } from "./external-signatures/table-cache.js";
import { fileIsInlineTestOnly, isInlineTestNode, outerAttributes } from "./inline-tests.js";
import { parseRustTargetRootFiles, RUST_CRATE_MANIFEST_FILE } from "./manifest.js";

const BODYLESS_MOD_DECLARATION = /\bmod\s+(?:r#)?[A-Za-z_][A-Za-z0-9_]*\s*;/;
const CFG_ATTRIBUTE = /\bcfg\s*\(/;
const PATH_ATTRIBUTE = /^path\s*=\s*"((?:[^"\\]|\\.)*)"$/;
/** Files whose declarations resolve under their own directory (the reference's "mod-rs" files). */
const MOD_RS_BASENAMES = new Set(["mod.rs", "lib.rs", "main.rs", "build.rs"]);
/** Crate roots Cargo discovers by location: `src/bin/*.rs` and top-level `tests|examples|benches/*.rs`. */
const CRATE_ROOT_BY_LOCATION = /(?:^|\/)(?:src\/bin|tests|examples|benches)\/[^/]+\.rs$/;
const READ_BATCH_SIZE = 32;

/** The module files one Rust file's body-less `mod` declarations reach, split by whether they are test-only. */
interface RustModuleDeclarations {
  readonly testOnly: readonly string[];
  readonly all: readonly string[];
}

/** Where a body-less `mod` sits: the inline modules around it and whether one of them is test-only. */
interface RustModuleDeclarationScope {
  readonly inlinePath: readonly string[];
  readonly testOnly: boolean;
}

/**
 * The files of `query.relativePaths` that are Rust test code by declaration.
 * Total and silent: an unreadable file declares nothing.
 */
export async function findRustDeclaredTestFiles(
  query: DeclaredTestFileQuery,
  loadParser: RustSourceParserLoader = loadRustSourceParser,
): Promise<ReadonlySet<string>> {
  const runFiles = new Set(query.relativePaths);
  const declaring = await readDeclaringSources(query);
  const targetRoots = declaring.size === 0 ? new Set<string>() : await readManifestTargetRoots(query);
  let parse: ((source: string) => AstNode) | undefined;
  const parsed = new Map<string, RustModuleDeclarations>();
  const declarationsOf = (relativePath: string): RustModuleDeclarations | undefined => {
    const source = declaring.get(relativePath);
    if (source === undefined) return undefined;
    let declarations = parsed.get(relativePath);
    if (!declarations) {
      parse ??= loadParser();
      declarations = collectModuleDeclarations(relativePath, source, parse(source), runFiles, targetRoots);
      parsed.set(relativePath, declarations);
    }
    return declarations;
  };

  const declared = new Set<string>();
  const pending: string[] = [];
  const add = (relativePath: string): void => {
    if (declared.has(relativePath)) return;
    declared.add(relativePath);
    pending.push(relativePath);
  };
  for (const [relativePath, source] of declaring) {
    if (CFG_ATTRIBUTE.test(source)) declarationsOf(relativePath)?.testOnly.forEach(add);
  }
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    declarationsOf(next)?.all.forEach(add);
  }
  return declared;
}

/** The source of every `.rs` file of the run that holds a body-less `mod` declaration. */
async function readDeclaringSources(query: DeclaredTestFileQuery): Promise<Map<string, string>> {
  const rustFiles = query.relativePaths.filter((relativePath) => relativePath.endsWith(".rs"));
  const sources = new Map<string, string>();
  for (const [relativePath, content] of await readRunFiles(query, rustFiles)) {
    if (BODYLESS_MOD_DECLARATION.test(content)) sources.set(relativePath, content);
  }
  return sources;
}

/**
 * The crate roots the run's `Cargo.toml` files set by `path` (`[lib] path`,
 * `[[bin]] path`, …), repo-relative. A custom root such as `src/core.rs` is a
 * crate root wherever it sits, so its declarations resolve under its own
 * directory — the location rules cannot know it.
 */
async function readManifestTargetRoots(query: DeclaredTestFileQuery): Promise<Set<string>> {
  const manifests = query.relativePaths.filter(
    (relativePath) => posix.basename(relativePath) === RUST_CRATE_MANIFEST_FILE,
  );
  const roots = new Set<string>();
  for (const [manifest, content] of await readRunFiles(query, manifests)) {
    for (const rootFile of parseRustTargetRootFiles(content)) {
      roots.add(posix.normalize(posix.join(posix.dirname(manifest), rootFile)));
    }
  }
  return roots;
}

/** The readable contents of `relativePaths`, read in bounded batches. */
async function readRunFiles(
  query: DeclaredTestFileQuery,
  relativePaths: readonly string[],
): Promise<Map<string, string>> {
  const contents = new Map<string, string>();
  for (let start = 0; start < relativePaths.length; start += READ_BATCH_SIZE) {
    const batch = relativePaths.slice(start, start + READ_BATCH_SIZE);
    const read = await Promise.all(batch.map(async (relativePath) => query.readFile(relativePath)));
    batch.forEach((relativePath, index) => {
      const content = read[index];
      if (content !== undefined) contents.set(relativePath, content);
    });
  }
  return contents;
}

function collectModuleDeclarations(
  relativePath: string,
  source: string,
  root: AstNode,
  runFiles: ReadonlySet<string>,
  targetRoots: ReadonlySet<string>,
): RustModuleDeclarations {
  const testOnly: string[] = [];
  const all: string[] = [];
  const visit = (container: AstNode, scope: RustModuleDeclarationScope): void => {
    for (const item of container.namedChildren) {
      if (item.type !== "mod_item") continue;
      const name = item.namedChildren.find((child) => child.type === "identifier")?.text;
      if (name === undefined) continue;
      const itemIsTestOnly = scope.testOnly || isInlineTestNode(item, source);
      const body = item.namedChildren.find((child) => child.type === "declaration_list");
      if (body) {
        visit(body, { inlinePath: [...scope.inlinePath, name], testOnly: itemIsTestOnly });
        continue;
      }
      const target = resolveModuleFile(
        relativePath,
        scope.inlinePath,
        name,
        declaredPathOf(item),
        runFiles,
        targetRoots,
      );
      if (target === undefined) continue;
      all.push(target);
      if (itemIsTestOnly) testOnly.push(target);
    }
  };
  visit(root, { inlinePath: [], testOnly: fileIsInlineTestOnly(root, source) });
  return { testOnly, all };
}

/** The string of a `#[path = "…"]` outer attribute on the declaration, if any. */
function declaredPathOf(item: AstNode): string | undefined {
  for (const attribute of outerAttributes(item)) {
    const match = PATH_ATTRIBUTE.exec(attribute.text.trim());
    if (match) return match[1];
  }
  return undefined;
}

function resolveModuleFile(
  declaringFile: string,
  inlinePath: readonly string[],
  name: string,
  declaredPath: string | undefined,
  runFiles: ReadonlySet<string>,
  targetRoots: ReadonlySet<string>,
): string | undefined {
  const fileDirectory = posix.dirname(declaringFile);
  const moduleDirectory = isModRsFile(declaringFile, targetRoots)
    ? fileDirectory
    : posix.join(fileDirectory, posix.basename(declaringFile, ".rs"));
  const candidates =
    declaredPath !== undefined
      ? [
          inlinePath.length === 0
            ? posix.join(fileDirectory, declaredPath)
            : posix.join(moduleDirectory, ...inlinePath, declaredPath),
        ]
      : [
          posix.join(moduleDirectory, ...inlinePath, `${name}.rs`),
          posix.join(moduleDirectory, ...inlinePath, name, "mod.rs"),
        ];
  return candidates.find((candidate) => runFiles.has(candidate));
}

function isModRsFile(relativePath: string, targetRoots: ReadonlySet<string>): boolean {
  return (
    MOD_RS_BASENAMES.has(posix.basename(relativePath)) ||
    CRATE_ROOT_BY_LOCATION.test(relativePath) ||
    targetRoots.has(relativePath)
  );
}

/** Rust's declared-test-file capability, handed to the factory's languages. */
export const RUST_DECLARED_TEST_FILES: DeclaredTestFileSource = {
  findDeclaredTestFiles: async (query) => findRustDeclaredTestFiles(query),
};
