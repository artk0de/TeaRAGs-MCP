/**
 * Shared inputs and helpers for the Rust symbol-resolution strategies.
 *
 * `ResolverConfig` is the per-resolver config every strategy receives by
 * constructor injection (the old `RustCallResolver(mode)` argument). The shared
 * helpers below are the lookups several strategies use — factored here so they
 * live once.
 */

import { identifierEntry } from "../../../../../contracts/identifier-record.js";
import {
  pickSingleCandidate,
  type AmbiguousResolveMode,
  type CallContext,
  type CallRef,
  type SymbolDefinition,
  type SymbolDefinitionKind,
  type SymbolResolutionTarget,
} from "../../../../../contracts/types/codegraph.js";
import { capability } from "../../capability.js";
import { rustTextIsStdPathHead } from "../../vocabulary/std-prelude.js";
import { rustWorkspaceCratesOf } from "../workspace-crates.js";

export interface ResolverConfig {
  mode: AmbiguousResolveMode;
}

/**
 * bd tea-rags-mcp-c5by — look up `<enclosingType>#<member>` (instance)
 * then `<enclosingType>.<member>` (associated function) constrained
 * to the caller's own file. Mirrors `JavaCallResolver.lookupEnclosingMember`
 * — Rust shares the convention (instance methods use `#`, associated
 * functions use `.`) so the same lookup works.
 */
export function lookupEnclosingMember(member: string, ctx: CallContext): SymbolResolutionTarget | null {
  const enclosing = ctx.callerScope[ctx.callerScope.length - 1];
  const instanceFq = `${enclosing}#${member}`;
  const instanceHit = ctx.symbolTable.lookup(instanceFq).find((def) => def.relPath === ctx.callerFile);
  if (instanceHit) return { targetRelPath: instanceHit.relPath, targetSymbolId: instanceHit.symbolId };
  const staticFq = `${enclosing}.${member}`;
  const staticHit = ctx.symbolTable.lookup(staticFq).find((def) => def.relPath === ctx.callerFile);
  if (staticHit) return { targetRelPath: staticHit.relPath, targetSymbolId: staticHit.symbolId };
  return null;
}

/**
 * bd tea-rags-mcp-p8wz — resolve a bound-type member (`<Type>#<member>` /
 * `<Type>.<member>`) preferring the candidate in the caller's own file when the
 * type name collides across files. ripgrep declares `Parser` in BOTH
 * `crates/core/flags/parse.rs` and `crates/globset/src/glob.rs`, so a typed
 * binding `let parser = Parser::new(); parser.parse()` inside parse.rs would
 * otherwise hit two `Parser#parse` rows and drop on ambiguity. A locally
 * declared type's method is local — Rust name resolution, not a guess. Only a
 * unique same-file candidate shortcuts; everything else defers to the ambiguity
 * policy (which still drops genuinely cross-file collisions).
 */
export function pickSameFileThenSingle(
  candidates: SymbolDefinition[],
  callerFile: string,
  mode: AmbiguousResolveMode,
): SymbolDefinition | null {
  const sameFile = candidates.filter((def) => def.relPath === callerFile);
  if (sameFile.length === 1) return sameFile[0];
  return pickSingleCandidate(candidates, mode);
}

/**
 * Short-name lookup restricted to RUST candidates. The symbol table is one
 * polyglot index with no `language` field, and a TypeScript `Parser.new` is
 * spelled exactly like Rust's, so a bare `lookupByShortName` lets a foreign
 * namesake be picked or trip the single-candidate gate
 * (`.claude/rules/resolver-architecture.md` §2). Used by `typeReceiver`
 * (bd tea-rags-mcp-7266); the older passes still read the table directly.
 */
export function lookupRustSymbolsByShortName(ctx: CallContext, name: string): SymbolDefinition[] {
  return ctx.symbolTable.lookupByShortName(name).filter((def) => def.relPath.endsWith(".rs"));
}

/**
 * The callee-role slice of the same lookup — what a CALL can land on, asked
 * with the capability's own role set (bd tea-rags-mcp-jqvbn) so a trait,
 * enum or constant sharing the name never turns a sole function ambiguous.
 * The one helper every member-keyed consumer shares: the strategies, the
 * facade's `hasInProjectDefinition` and the external vocabulary.
 */
export function rustCalleeShortNameCandidates(ctx: CallContext, name: string): SymbolDefinition[] {
  return ctx.symbolTable
    .lookupByShortName(name, { kinds: capability.codegraph.symbolKindRoles.callee })
    .filter((def) => def.relPath.endsWith(".rs"));
}

/**
 * Whether one of `relPaths` declares `name` as a type ALIAS (`type Range =
 * Match;`) — read from the symbol table's kind or, for an alias the table
 * holds no row for (a private module-level `type`), from the run's
 * declaration facts. An alias owns no members of its own (bd
 * tea-rags-mcp-sjego).
 */
export function rustDeclaresTypeAlias(name: string, relPaths: readonly string[], ctx: CallContext): boolean {
  const tableAlias = lookupRustSymbolsByShortName(ctx, name).some(
    (def) => def.symbolKind === "type_alias" && relPaths.includes(def.relPath),
  );
  if (tableAlias) return true;
  return relPaths.some((relPath) =>
    (ctx.typeDeclarations?.[relPath] ?? []).some((fact) => fact.symbolKind === "type_alias" && fact.typeId === name),
  );
}

const RUST_MACRO_KINDS: ReadonlySet<SymbolDefinitionKind> = new Set(["macro"]);

/**
 * The macro-namespace slice of the same lookup (bd tea-rags-mcp-s3i8m.2): what
 * a macro INVOCATION can land on. `format!` never names `fn format`, so a
 * function, method or type sharing the name is no candidate — and the callee
 * role excludes `macro`, so the converse holds by construction.
 */
export function rustMacroShortNameCandidates(ctx: CallContext, name: string): SymbolDefinition[] {
  return ctx.symbolTable
    .lookupByShortName(name, { kinds: RUST_MACRO_KINDS })
    .filter((def) => def.relPath.endsWith(".rs"));
}

/**
 * Whether the call site is a macro invocation (`name!(…)`, `path::name!(…)`).
 * The walker emits one as a bare or path call whose member is the macro name;
 * only the `!` after the path in the site text tells it from a fn call.
 */
export function rustCallIsMacroInvocation(call: CallRef): boolean {
  const path = call.receiver === null ? call.member : `${call.receiver}::${call.member}`;
  return call.callText.startsWith(`${path}!`);
}

/** Path heads that address the caller's own crate (`$crate` is the macro-body spelling of `crate`). */
export const RUST_OWN_CRATE_PATH_HEADS: ReadonlySet<string> = new Set(["crate", "$crate", "self", "super"]);

/**
 * Whether a bare path head names something OUTSIDE the project: a reserved std
 * head is external by definition; any other head is a crate name, and the only
 * crate name that can be ours is one the project holds a module file or crate
 * directory for — asked through the symbol table, never the disk.
 */
export function rustPathHeadIsExternal(head: string, ctx: CallContext): boolean {
  if (rustTextIsStdPathHead(head)) return true;
  // A workspace member's crate name (bd tea-rags-mcp-sjego) is ours whatever
  // its directory is called: `grep_matcher` lives in `crates/matcher`.
  if (rustWorkspaceCratesOf(ctx)?.declares(head) === true) return false;
  // A workspace crate is a DIRECTORY (`script_bindings/lib.rs`); `hasFile` can
  // never see `<crate>.rs`, so without the directory arm every bare-head
  // `use script_bindings::Str` classified external and the type left the
  // placement channel.
  if (ctx.symbolTable.hasDirNamed?.(head) === true) return false;
  return !(ctx.symbolTable.hasFile(`${head}.rs`) || ctx.symbolTable.hasFile(`${head}/mod.rs`));
}

/**
 * Whether a macro PATH (`std::println!`, `log::debug!`, `macros::emit!`) names
 * a macro outside the project. Its own-crate heads never do, a std head always
 * does; any other head is external only when {@link rustPathHeadIsExternal}
 * proves it AND no project definition of the macro sits under a module of
 * that name — `macros::emit!` from `src/lib.rs` reaches `src/macros.rs`,
 * which the root-relative crate proof alone cannot see.
 */
export function rustMacroPathIsExternal(head: string, candidates: SymbolDefinition[], ctx: CallContext): boolean {
  if (RUST_OWN_CRATE_PATH_HEADS.has(head)) return false;
  if (rustTextIsStdPathHead(head)) return true;
  if (!rustPathHeadIsExternal(head, ctx)) return false;
  return !candidates.some((def) =>
    def.relPath.split("/").some((segment) => segment === head || segment === `${head}.rs`),
  );
}

/**
 * Whether a `use` import names something OUTSIDE the project — the proof the
 * external vocabulary and the import gates both read. A prefixed path
 * (`crate::` / `self::` / `super::`) is project by definition; a bare head is
 * judged by {@link rustPathHeadIsExternal}. A malformed import proves nothing
 * and reads internal. One use tree can mix roots
 * (`{walkdir::WalkDir, crate::Error}`), so a caller that knows the name it
 * matched passes `localName` and is answered for THAT binding.
 */
export function rustImportIsExternal(importText: string, ctx: CallContext, localName?: string): boolean {
  const bindings = rustImportBindings(importText);
  const binding =
    (localName === undefined ? undefined : bindings?.find((entry) => entry.localName === localName)) ?? bindings?.[0];
  if (!binding) return false;
  if (binding.prefix !== null) return false;
  const head = binding.moduleSegments[0];
  if (!head) return false;
  return rustPathHeadIsExternal(head, ctx);
}

type RustImportPrefix = "crate" | "self" | "super" | null;

export interface RustImportPath {
  prefix: RustImportPrefix;
  /** How many leading `super::` segments the path climbs; 0 unless `prefix` is `super`. */
  superDepth: number;
  moduleSegments: string[];
  sourceName: string | null;
  receiverMatches: boolean;
  groupImport: boolean;
  globImport: boolean;
}

export interface RustImportBinding {
  prefix: RustImportPrefix;
  /** How many leading `super::` segments the path climbs; 0 unless `prefix` is `super`. */
  superDepth: number;
  moduleSegments: string[];
  sourceName: string | null;
  localName: string;
  groupImport: boolean;
  globImport: boolean;
}

const RUST_PATH_SEGMENT = /^(?:[A-Za-z_][A-Za-z0-9_]*|r#[A-Za-z_][A-Za-z0-9_]*)$/;
const RUST_ALIAS = /^(.+?)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)$/;

function stripRustUsePrefix(importText: string): string {
  return importText
    .trim()
    .replace(/^(?:(?:pub)\s+)?use\s+/, "")
    .replace(/^::/, "");
}

function splitRustPrefix(segments: string[]): { prefix: RustImportPrefix; superDepth: number; segments: string[] } {
  const first = segments[0];
  if (first === "super") {
    let depth = 1;
    while (segments[depth] === "super") depth++;
    return { prefix: "super", superDepth: depth, segments: segments.slice(depth) };
  }
  if (first === "crate" || first === "self") return { prefix: first, superDepth: 0, segments: segments.slice(1) };
  return { prefix: null, superDepth: 0, segments };
}

function validRustSegments(segments: readonly string[]): boolean {
  return segments.length > 0 && segments.every((segment) => RUST_PATH_SEGMENT.test(segment));
}

/** One leaf of a use tree: its full path text, and whether it sat inside a `{…}` group. */
interface RustUseLeaf {
  path: string;
  grouped: boolean;
}

/** Split `text` on `separator` at brace depth 0; `null` when the braces do not balance. */
function splitRustUseTopLevel(text: string, separator: ","): string[] | null {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}" && --depth < 0) return null;
    else if (ch === separator && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  if (depth !== 0) return null;
  parts.push(text.slice(start));
  return parts;
}

/**
 * Flatten a use tree to its leaves (bd tea-rags-mcp-s3i8m.3): rustfmt writes
 * `std::{ffi::{OsStr, OsString}, io}` and `{walkdir::WalkDir, same_file::Handle}`,
 * and the one-level reading made every such import unparseable — no receiver
 * it bound could be placed or classified. `self` in a group binds the group's
 * own module path. `null` for anything malformed.
 */
function flattenRustUseTree(text: string, base: string, grouped: boolean): RustUseLeaf[] | null {
  const tree = text.trim();
  const open = tree.indexOf("{");
  if (open < 0) return tree.length === 0 ? null : [{ path: `${base}${tree}`, grouped }];
  if (!tree.endsWith("}")) return null;
  const head = tree.slice(0, open).trim();
  if (head.length > 0 && !head.endsWith("::")) return null;
  const members = splitRustUseTopLevel(tree.slice(open + 1, -1), ",");
  if (members === null) return null;
  const leaves: RustUseLeaf[] = [];
  for (const raw of members) {
    const member = raw.trim();
    // A trailing comma leaves one empty member; an empty group binds nothing.
    if (member.length === 0) continue;
    if (member === "self") {
      const modulePath = `${base}${head}`.replace(/::$/, "");
      if (modulePath.length === 0) return null;
      leaves.push({ path: modulePath, grouped: false });
      continue;
    }
    const nested = flattenRustUseTree(member, `${base}${head}`, true);
    if (nested === null) return null;
    leaves.push(...nested);
  }
  return leaves;
}

/** One flattened leaf as a binding — a grouped leaf names its module path and the item inside it. */
function rustUseLeafBinding(leaf: RustUseLeaf): RustImportBinding | null {
  const alias = leaf.path.match(RUST_ALIAS);
  const segments = (alias?.[1] ?? leaf.path).split("::").map((segment) => segment.trim());
  if (segments.some((segment) => segment.length === 0)) return null;
  const { prefix, superDepth, segments: pathSegments } = splitRustPrefix(segments);
  if (pathSegments.length === 0) return null;
  const last = pathSegments.at(-1) ?? "";
  const moduleSegments = pathSegments.slice(0, -1);
  if (last === "*") {
    if (alias || !validRustSegments(moduleSegments)) return null;
    return {
      prefix,
      superDepth,
      moduleSegments,
      sourceName: null,
      localName: "*",
      groupImport: leaf.grouped,
      globImport: true,
    };
  }
  if (!validRustSegments(pathSegments)) return null;
  const localName = alias?.[2] ?? last;
  // `crate::{a}` names module `a` exactly as `use crate::a;` does.
  if (leaf.grouped && moduleSegments.length > 0) {
    return { prefix, superDepth, moduleSegments, sourceName: last, localName, groupImport: true, globImport: false };
  }
  return {
    prefix,
    superDepth,
    moduleSegments: pathSegments,
    sourceName: null,
    localName,
    groupImport: false,
    globImport: false,
  };
}

export function rustImportBindings(importText: string): RustImportBinding[] | null {
  const text = stripRustUsePrefix(importText).replace(/;$/, "");
  if (text.includes("{")) {
    const leaves = flattenRustUseTree(text, "", false);
    if (leaves === null || leaves.length === 0) return null;
    const bindings = leaves.map(rustUseLeafBinding);
    return bindings.every((binding): binding is RustImportBinding => binding !== null) ? bindings : null;
  }
  const segments = text.split("::").map((segment) => segment.trim());
  if (segments.some((segment) => segment.length === 0)) return null;
  const { prefix, superDepth, segments: pathSegments } = splitRustPrefix(segments);
  if (pathSegments.length === 0) return null;
  const last = pathSegments.at(-1) ?? "";

  if (last === "*") {
    const moduleSegments = pathSegments.slice(0, -1);
    return validRustSegments(moduleSegments)
      ? [{ prefix, superDepth, moduleSegments, sourceName: null, localName: "*", groupImport: false, globImport: true }]
      : null;
  }

  const alias = last.match(RUST_ALIAS);
  if (alias) {
    const sourcePath = alias[1].trim().split("::");
    if (!validRustSegments(sourcePath)) return null;
    return [
      {
        prefix,
        superDepth,
        moduleSegments: [...pathSegments.slice(0, -1), ...sourcePath],
        sourceName: null,
        localName: alias[2],
        groupImport: false,
        globImport: false,
      },
    ];
  }
  if (!validRustSegments(pathSegments)) return null;
  return [
    {
      prefix,
      superDepth,
      moduleSegments: pathSegments,
      sourceName: null,
      localName: pathSegments.at(-1) ?? "",
      groupImport: false,
      globImport: false,
    },
  ];
}

function parseRustImport(importText: string, receiver: string): RustImportPath | null {
  const bindings = rustImportBindings(importText);
  if (bindings === null) return null;
  const matching = bindings.find((binding) => binding.localName === receiver && !binding.globImport);
  if (matching) {
    return { ...matching, receiverMatches: true };
  }
  const glob = bindings.find((binding) => binding.globImport && binding.moduleSegments.at(-1) === receiver);
  if (glob) return { ...glob, receiverMatches: true };
  return bindings[0] ? { ...bindings[0], receiverMatches: false } : null;
}

export function parseRustImportPath(importText: string, receiver: string): RustImportPath | null {
  return parseRustImport(importText, receiver);
}

export function rustImportMatchesReceiver(importText: string, receiver: string): boolean {
  return parseRustImport(importText, receiver)?.receiverMatches ?? false;
}

export function rustImportSuffix(importText: string): string | null {
  const parsed = parseRustImport(importText, "");
  if (!parsed || parsed.moduleSegments.length === 0) return null;
  return parsed.moduleSegments.join("/");
}

/** A cheap malformed-path guard for an import that names the receiver anywhere in its path. */
export function rustImportContainsReceiver(importText: string, receiver: string): boolean {
  const bindings = rustImportBindings(importText);
  if (bindings === null) return stripRustUsePrefix(importText).split("::").includes(receiver);
  return bindings.some((binding) => binding.localName === receiver || binding.moduleSegments.includes(receiver));
}

export function rustImportCandidateSuffix(importText: string, receiver: string): string | null {
  const parsed = parseRustImport(importText, receiver);
  if (parsed?.receiverMatches !== true) return null;
  return parsed.moduleSegments.join("/");
}

/** Where a path's prefix resolves from: the import origin a binding carries. */
export type RustImportOrigin = Pick<RustImportBinding, "prefix" | "superDepth">;

/** Module roots own their directory; any other `x.rs` is module `x`, whose children sit under `x/`. */
const RUST_DIRECTORY_MODULE_FILES = new Set(["mod.rs", "lib.rs", "main.rs"]);

function parentDir(dir: string): string {
  return dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
}

function rustImportRoot(origin: RustImportOrigin, callerFile: string): string {
  const callerDir = parentDir(callerFile);
  const segments = callerFile.split("/");
  const srcIndex = segments.indexOf("src");
  if (origin.prefix === "crate") return srcIndex >= 0 ? segments.slice(0, srcIndex + 1).join("/") : callerDir;
  const fileName = segments.at(-1) ?? "";
  const moduleDir = RUST_DIRECTORY_MODULE_FILES.has(fileName)
    ? callerDir
    : `${callerDir ? `${callerDir}/` : ""}${fileName.replace(/\.rs$/, "")}`;
  if (origin.prefix === "self") return moduleDir;
  if (origin.prefix !== "super") return "";
  let root = moduleDir;
  for (let climbed = 0; climbed < origin.superDepth; climbed++) root = parentDir(root);
  return root;
}

/**
 * The candidate crate roots for a `crate::` import, most specific first:
 * every ancestor directory of the caller, qualified where the table holds a
 * crate-root marker (`lib.rs` / `main.rs`). A corpus that indexes no marker
 * still answers — every ancestor is scanned, because the caller's own
 * directory chain is the only place a crate root can sit. Membership is
 * asked through the symbol table, never the disk.
 */
function rustTableCrateRoots(callerFile: string, ctx: CallContext): string[] | null {
  if (typeof ctx.symbolTable.hasFile !== "function") return null;
  const segments = callerFile.split("/");
  const dirs: string[] = [];
  for (let i = segments.length - 1; i >= 1; i--) dirs.push(segments.slice(0, i).join("/"));
  dirs.push("");
  const marked = dirs.filter((dir) => {
    const prefix = dir ? `${dir}/` : "";
    return ctx.symbolTable.hasFile(`${prefix}lib.rs`) || ctx.symbolTable.hasFile(`${prefix}main.rs`);
  });
  return marked.length > 0 ? marked : dirs;
}

export function rustModuleCandidatePaths(importText: string, callerFile: string): string[] | null {
  const bindings = rustImportBindings(importText);
  const binding = bindings?.find((entry) => !entry.globImport) ?? bindings?.[0];
  if (!binding) return bindings === null ? null : [];
  const root = rustImportRoot(binding, callerFile);
  const suffix = binding.moduleSegments.join("/");
  const candidate = root ? `${root}/${suffix}` : suffix;
  return [`${candidate}.rs`, `${candidate}/mod.rs`];
}

/** The crate root a bare path head names when it is a workspace member's crate name (bd tea-rags-mcp-sjego). */
interface RustWorkspaceCrateRoot {
  rootDirs: readonly string[];
  rootFiles: readonly string[];
}

function rustWorkspaceCrateRoot(
  origin: RustImportOrigin,
  moduleSegments: readonly string[],
  ctx: CallContext | undefined,
): RustWorkspaceCrateRoot | undefined {
  const head = moduleSegments[0];
  if (origin.prefix !== null || ctx === undefined || head === undefined) return undefined;
  const crates = rustWorkspaceCratesOf(ctx);
  if (crates?.declares(head) !== true) return undefined;
  return { rootDirs: crates.rootDirsOf(head), rootFiles: crates.rootFilesOf(head) };
}

/**
 * The files a module path below a workspace crate's root can live in — the
 * same `<path>.rs` / `<path>/mod.rs` pair `crate::` yields inside the member;
 * the empty path is the crate root file itself.
 */
function rustCrateRootedPaths(crate: RustWorkspaceCrateRoot, segments: readonly string[]): string[] {
  if (segments.length === 0) return [...crate.rootFiles];
  return crate.rootDirs.flatMap((dir) => {
    const base = dir ? `${dir}/${segments.join("/")}` : segments.join("/");
    return [`${base}.rs`, `${base}/mod.rs`];
  });
}

export function rustPathCandidatePaths(
  origin: RustImportOrigin,
  moduleSegments: readonly string[],
  callerFile: string,
  ctx?: CallContext,
): string[] {
  const crate = rustWorkspaceCrateRoot(origin, moduleSegments, ctx);
  if (crate !== undefined) return rustCrateRootedPaths(crate, moduleSegments.slice(1));
  const suffix = moduleSegments.join("/");
  const tableRoots = origin.prefix === "crate" && ctx ? rustTableCrateRoots(callerFile, ctx) : null;
  if (tableRoots) {
    return [
      ...new Set(
        tableRoots.flatMap((root) => {
          const base = root ? `${root}/${suffix}` : suffix;
          return [`${base}.rs`, `${base}/mod.rs`];
        }),
      ),
    ];
  }
  const root = rustImportRoot(origin, callerFile);
  const candidate = root ? `${root}/${suffix}` : suffix;
  return [`${candidate}.rs`, `${candidate}/mod.rs`];
}

export function rustImportCandidatePaths(
  importText: string,
  receiver: string,
  callerFile: string,
  ctx?: CallContext,
): string[] | null {
  const parsed = parseRustImport(importText, receiver);
  if (!parsed?.receiverMatches) return parsed ? [] : null;
  const crate = rustWorkspaceCrateRoot(parsed, parsed.moduleSegments, ctx);
  if (crate !== undefined) {
    // `use grep_matcher::{Match as Range}` reads like `use crate::{Match as Range}`
    // inside crates/matcher: the module, the grouped item's own module file,
    // and — for a plain item binding — the module that holds the item.
    const rest = parsed.moduleSegments.slice(1);
    const paths = rustCrateRootedPaths(crate, rest);
    if (parsed.sourceName !== null) paths.push(...rustCrateRootedPaths(crate, [...rest, parsed.sourceName]));
    if (!parsed.groupImport && rest.length > 0) paths.push(...rustCrateRootedPaths(crate, rest.slice(0, -1)));
    return [...new Set(paths)];
  }
  const tableRoots = parsed.prefix === "crate" && ctx ? rustTableCrateRoots(callerFile, ctx) : null;
  const root = rustImportRoot(parsed, callerFile);
  const candidates: string[] = [];
  const push = (suffix: string): void => {
    if (tableRoots) {
      for (const tableRoot of tableRoots) {
        const base = tableRoot ? `${tableRoot}/${suffix}` : suffix;
        candidates.push(`${base}.rs`, `${base}/mod.rs`);
      }
      return;
    }
    const base = root ? `${root}/${suffix}` : suffix;
    candidates.push(`${base}.rs`, `${base}/mod.rs`);
  };
  const moduleSuffix = parsed.moduleSegments.join("/");
  push(moduleSuffix);
  if (parsed.sourceName !== null) push(`${moduleSuffix}/${parsed.sourceName}`);
  // A plain binding `use crate::a::b::item` can bind an ITEM inside module
  // `a::b`, whose file is `a/b.rs` — the last segment is the item, not the
  // module. Without the parent candidates the bare-call arm found no file
  // for every direct function import (bd tea-rags-mcp-2g2og).
  if (!parsed.groupImport && parsed.moduleSegments.length > 1) push(parsed.moduleSegments.slice(0, -1).join("/"));
  // `use super::{escape}` / `use crate::new_regex` bind an ITEM of the prefix's
  // own module, whose file is the module root itself — and `super::` written in
  // an inline `mod tests { }` names the file that holds it, the caller's own
  // (bd tea-rags-mcp-s3i8m.3).
  if (parsed.prefix !== null && parsed.sourceName === null && parsed.moduleSegments.length === 1) {
    const roots = tableRoots ?? [root];
    for (const moduleRoot of roots) {
      const base = moduleRoot ? `${moduleRoot}/` : "";
      if (moduleRoot) candidates.push(`${moduleRoot}.rs`);
      candidates.push(`${base}mod.rs`, `${base}lib.rs`, `${base}main.rs`);
    }
    if (parsed.prefix !== "crate") candidates.push(callerFile);
  }
  return [...new Set(candidates)];
}

/** Whether the run knows `relPath` as a module file: the symbol table holds it, or it wrote `pub use` facts. */
export function rustModuleFileKnown(relPath: string, ctx: CallContext): boolean {
  return ctx.symbolTable.hasFile(relPath) || identifierEntry(ctx.moduleReexports, relPath) !== undefined;
}

/**
 * The files a `pub use` SOURCE module names, read from the module that wrote
 * it (bd tea-rags-mcp-s3i8m.8): `self::peer` / `super::x` / `crate::x` climb
 * from `moduleFile`, never from the caller. A bare head is a workspace crate,
 * else a child module of `moduleFile` the run holds (2018 relative paths:
 * `pub use peer::find_peer;`), else an external crate. `"external"` when the
 * source is outside the project; `null` when the path cannot be followed.
 */
export function rustReexportSourcePaths(
  sourceModule: string,
  moduleFile: string,
  ctx: CallContext,
): string[] | "external" | null {
  const raw = sourceModule.replace(/^::/, "").split("::");
  if (raw.length === 0 || raw.some((segment) => segment.length === 0)) return null;
  const { prefix, superDepth, segments } = splitRustPrefix(raw);
  if (segments.length > 0 && !validRustSegments(segments)) return null;
  if (prefix !== null) {
    if (segments.length > 0) return rustPathCandidatePaths({ prefix, superDepth }, segments, moduleFile, ctx);
    if (prefix === "self") return [moduleFile];
    const root = rustImportRoot({ prefix, superDepth }, moduleFile);
    const base = root ? `${root}/` : "";
    return [...(root ? [`${root}.rs`] : []), `${base}mod.rs`, `${base}lib.rs`, `${base}main.rs`];
  }
  const crate = rustWorkspaceCrateRoot({ prefix, superDepth }, segments, ctx);
  if (crate !== undefined) return rustCrateRootedPaths(crate, segments.slice(1));
  const child = rustPathCandidatePaths({ prefix: "self", superDepth: 0 }, segments, moduleFile, ctx);
  if (child.some((relPath) => rustModuleFileKnown(relPath, ctx))) return child;
  const head = segments[0];
  return head !== undefined && rustPathHeadIsExternal(head, ctx) ? "external" : null;
}

export function rustImportGlobCandidatePaths(importText: string, callerFile: string): string[] | null {
  const bindings = rustImportBindings(importText);
  const glob = bindings?.find((binding) => binding.globImport);
  if (!glob) return bindings === null ? null : [];
  const root = rustImportRoot(glob, callerFile);
  const suffix = glob.moduleSegments.join("/");
  const candidate = root ? `${root}/${suffix}` : suffix;
  return [`${candidate}.rs`, `${candidate}/mod.rs`];
}

/** How many `pub use` hops a re-export walk follows from the pinned module before it stops proving absence. */
const RUST_REEXPORT_HOP_CAP = 4;

export interface RustReexportFollow {
  target: SymbolResolutionTarget | null;
  open: boolean;
}

/**
 * Follow the `pub use` re-exports of the module an import pins, hop-bounded
 * by {@link RUST_REEXPORT_HOP_CAP}. The import is read from `fromFile`, the
 * file that wrote it: the caller's for a call, a callee's or a struct's for a
 * declared type (bd tea-rags-mcp-s3i8m letCall S4b). `defsOf(sourceName)`
 * answers the definitions a re-export source may hold under the name it
 * exports. `target` is the one definition the walk ends at; `open` is set
 * when the walk met something it cannot follow — an unknown or absent module
 * file, a relative path it cannot place, a glob from an external crate, the
 * hop cap, the reexport channel absent, or more than one definition — so its
 * silence is no proof of absence.
 */
export function rustFollowReexports(
  importText: string,
  receiver: string,
  fromFile: string,
  ctx: CallContext,
  defsOf: (sourceName: string) => readonly SymbolDefinition[],
): RustReexportFollow {
  const parsed = parseRustImportPath(importText, receiver);
  if (!parsed || ctx.moduleReexports === undefined) return { target: null, open: true };
  const ownerSegments = parsed.sourceName === null ? parsed.moduleSegments.slice(0, -1) : parsed.moduleSegments;
  const exportedName = parsed.sourceName === null ? (parsed.moduleSegments.at(-1) ?? receiver) : parsed.sourceName;
  // `crate::X` / `super::X` re-exported by the prefix's own module: its root file.
  const prefixRoot =
    ownerSegments.length === 0 && parsed.prefix !== null
      ? rustReexportSourcePaths(
          parsed.prefix === "super"
            ? Array.from({ length: parsed.superDepth }, () => "super").join("::")
            : parsed.prefix,
          fromFile,
          ctx,
        )
      : undefined;
  const ownerFiles = (
    Array.isArray(prefixRoot) ? prefixRoot : rustPathCandidatePaths(parsed, ownerSegments, fromFile, ctx)
  ).filter((relPath) => rustModuleFileKnown(relPath, ctx));
  // An inline `mod tests { pub use … }` has no file of its own: nothing proves absence.
  let open = ownerFiles.length === 0;
  const targets: SymbolResolutionTarget[] = [];
  const visited = new Set<string>();
  const visit = (moduleFile: string, name: string, depth: number): void => {
    const key = `${moduleFile}::${name}`;
    if (visited.has(key)) return;
    visited.add(key);
    for (const entry of identifierEntry(ctx.moduleReexports, moduleFile) ?? []) {
      if (entry.exportedName !== name && entry.exportedName !== "*") continue;
      if (depth >= RUST_REEXPORT_HOP_CAP) {
        open = true;
        continue;
      }
      const sourcePaths = rustReexportSourcePaths(entry.sourceModule, moduleFile, ctx);
      // A NAMED re-export of an external item proves the name external; a
      // glob from an external crate may or may not carry it.
      if (sourcePaths === "external") {
        if (entry.exportedName === "*") open = true;
        continue;
      }
      if (sourcePaths === null) {
        open = true;
        continue;
      }
      const sourceName = entry.exportedName === "*" ? name : (entry.sourceName ?? name);
      const moduleItemPaths =
        entry.sourceName === undefined
          ? []
          : rustReexportSourcePaths(`${entry.sourceModule}::${entry.sourceName}`, moduleFile, ctx);
      const sourceFiles = [
        ...new Set([...sourcePaths, ...(Array.isArray(moduleItemPaths) ? moduleItemPaths : [])]),
      ].filter((relPath) => rustModuleFileKnown(relPath, ctx));
      if (sourceFiles.length === 0) {
        open = true;
        continue;
      }
      const defs = defsOf(sourceName);
      for (const sourceFile of sourceFiles) {
        for (const def of defs) {
          if (def.relPath === sourceFile) {
            targets.push({ targetRelPath: def.relPath, targetSymbolId: def.symbolId });
          }
        }
        visit(sourceFile, sourceName, depth + 1);
      }
    }
  };
  for (const ownerFile of ownerFiles) visit(ownerFile, exportedName, 0);
  const unique = [...new Map(targets.map((target) => [target.targetRelPath, target])).values()];
  if (unique.length === 1) return { target: unique[0], open };
  return { target: null, open: open || unique.length > 1 };
}
