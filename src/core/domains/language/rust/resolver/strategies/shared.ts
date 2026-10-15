/**
 * Shared inputs and helpers for the Rust symbol-resolution strategies.
 *
 * `ResolverConfig` is the per-resolver config every strategy receives by
 * constructor injection (the old `RustCallResolver(mode)` argument). The shared
 * helpers below are the lookups several strategies use — factored here so they
 * live once.
 */

import {
  pickSingleCandidate,
  type AmbiguousResolveMode,
  type CallContext,
  type SymbolDefinition,
  type SymbolResolutionTarget,
} from "../../../../../contracts/types/codegraph.js";

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

type RustImportPrefix = "crate" | "self" | "super" | null;

export interface RustImportPath {
  prefix: RustImportPrefix;
  moduleSegments: string[];
  sourceName: string | null;
  receiverMatches: boolean;
  groupImport: boolean;
  globImport: boolean;
}

export interface RustImportBinding {
  prefix: RustImportPrefix;
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

function splitRustPrefix(segments: string[]): { prefix: RustImportPrefix; segments: string[] } {
  const first = segments[0];
  if (first === "crate" || first === "self" || first === "super") return { prefix: first, segments: segments.slice(1) };
  return { prefix: null, segments };
}

function validRustSegments(segments: readonly string[]): boolean {
  return segments.length > 0 && segments.every((segment) => RUST_PATH_SEGMENT.test(segment));
}

export function rustImportBindings(importText: string): RustImportBinding[] | null {
  const segments = stripRustUsePrefix(importText)
    .replace(/;$/, "")
    .split("::")
    .map((segment) => segment.trim());
  if (segments.some((segment) => segment.length === 0)) return null;
  const { prefix, segments: pathSegments } = splitRustPrefix(segments);
  if (pathSegments.length === 0) return null;
  const last = pathSegments.at(-1) ?? "";

  if (last.startsWith("{") || last.endsWith("}")) {
    if (!last.startsWith("{") || !last.endsWith("}")) return null;
    const moduleSegments = pathSegments.slice(0, -1);
    if (!validRustSegments(moduleSegments)) return null;
    const members = last
      .slice(1, -1)
      .split(",")
      .map((member) => member.trim());
    if (members.length === 0) return null;
    const bindings = members.map((member): RustImportBinding | null => {
      if (member === "*") {
        return { prefix, moduleSegments, sourceName: null, localName: "*", groupImport: true, globImport: true };
      }
      const alias = member.match(RUST_ALIAS);
      const sourceName = (alias?.[1] ?? member).trim();
      const localName = alias?.[2] ?? sourceName;
      if (!RUST_PATH_SEGMENT.test(sourceName) || !RUST_PATH_SEGMENT.test(localName)) return null;
      return { prefix, moduleSegments, sourceName, localName, groupImport: true, globImport: false };
    });
    return bindings.every((binding): binding is RustImportBinding => binding !== null) ? bindings : null;
  }

  if (last === "*") {
    const moduleSegments = pathSegments.slice(0, -1);
    return validRustSegments(moduleSegments)
      ? [{ prefix, moduleSegments, sourceName: null, localName: "*", groupImport: false, globImport: true }]
      : null;
  }

  const alias = last.match(RUST_ALIAS);
  if (alias) {
    const sourcePath = alias[1].trim().split("::");
    if (!validRustSegments(sourcePath)) return null;
    return [
      {
        prefix,
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

function rustImportRoot(prefix: RustImportPrefix, callerFile: string): string {
  const callerDir = callerFile.includes("/") ? callerFile.slice(0, callerFile.lastIndexOf("/")) : "";
  const segments = callerFile.split("/");
  const srcIndex = segments.indexOf("src");
  const crateRoot = srcIndex >= 0 ? segments.slice(0, srcIndex + 1).join("/") : callerDir;
  const parentRoot = callerDir.includes("/") ? callerDir.slice(0, callerDir.lastIndexOf("/")) : "";
  return prefix === "crate" ? crateRoot : prefix === "self" ? callerDir : prefix === "super" ? parentRoot : "";
}

export function rustModuleCandidatePaths(importText: string, callerFile: string): string[] | null {
  const bindings = rustImportBindings(importText);
  const binding = bindings?.find((entry) => !entry.globImport) ?? bindings?.[0];
  if (!binding) return bindings === null ? null : [];
  const root = rustImportRoot(binding.prefix, callerFile);
  const suffix = binding.moduleSegments.join("/");
  const candidate = root ? `${root}/${suffix}` : suffix;
  return [`${candidate}.rs`, `${candidate}/mod.rs`];
}

export function rustPathCandidatePaths(
  prefix: RustImportPrefix,
  moduleSegments: readonly string[],
  callerFile: string,
): string[] {
  const root = rustImportRoot(prefix, callerFile);
  const suffix = moduleSegments.join("/");
  const candidate = root ? `${root}/${suffix}` : suffix;
  return [`${candidate}.rs`, `${candidate}/mod.rs`];
}

export function rustImportCandidatePaths(importText: string, receiver: string, callerFile: string): string[] | null {
  const parsed = parseRustImport(importText, receiver);
  if (!parsed?.receiverMatches) return parsed ? [] : null;
  const root = rustImportRoot(parsed.prefix, callerFile);
  const moduleSuffix = parsed.moduleSegments.join("/");
  const moduleCandidate = root ? `${root}/${moduleSuffix}` : moduleSuffix;
  const candidates = [`${moduleCandidate}.rs`, `${moduleCandidate}/mod.rs`];
  if (parsed.sourceName !== null) {
    const memberSuffix = `${moduleSuffix}/${parsed.sourceName}`;
    const memberCandidate = root ? `${root}/${memberSuffix}` : memberSuffix;
    candidates.push(`${memberCandidate}.rs`, `${memberCandidate}/mod.rs`);
  }
  return [...new Set(candidates)];
}

export function rustImportGlobCandidatePaths(importText: string, callerFile: string): string[] | null {
  const bindings = rustImportBindings(importText);
  const glob = bindings?.find((binding) => binding.globImport);
  if (!glob) return bindings === null ? null : [];
  const root = rustImportRoot(glob.prefix, callerFile);
  const suffix = glob.moduleSegments.join("/");
  const candidate = root ? `${root}/${suffix}` : suffix;
  return [`${candidate}.rs`, `${candidate}/mod.rs`];
}
