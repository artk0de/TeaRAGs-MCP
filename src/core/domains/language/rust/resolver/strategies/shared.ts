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
  receiverMatches: boolean;
  groupImport: boolean;
}

const RUST_PATH_SEGMENT = /^(?:[A-Za-z_][A-Za-z0-9_]*|r#[A-Za-z_][A-Za-z0-9_]*)$/;

function parseRustImport(importText: string, receiver: string): RustImportPath | null {
  const trimmed = importText.trim();
  const pathText = trimmed.startsWith("::") ? trimmed.slice(2) : trimmed;
  const segments = pathText.split("::");
  if (segments.some((segment) => segment.trim() === "")) return null;

  const first = segments[0]?.trim() ?? "";
  const prefix: RustImportPrefix = first === "crate" || first === "self" || first === "super" ? first : null;
  const pathSegments = prefix
    ? segments.slice(1).map((segment) => segment.trim())
    : segments.map((segment) => segment.trim());
  if (pathSegments.length === 0) return null;

  const last = pathSegments.at(-1) ?? "";
  if (last.startsWith("{") || last.endsWith("}")) {
    if (!last.startsWith("{") || !last.endsWith("}")) return null;
    const members = last
      .slice(1, -1)
      .split(",")
      .map((member) => member.trim());
    if (members.length === 0 || members.some((member) => !RUST_PATH_SEGMENT.test(member))) return null;
    if (pathSegments.slice(0, -1).some((segment) => !RUST_PATH_SEGMENT.test(segment))) return null;
    return {
      prefix,
      moduleSegments: pathSegments.slice(0, -1),
      receiverMatches: members.includes(receiver),
      groupImport: true,
    };
  }

  if (pathSegments.some((segment) => !RUST_PATH_SEGMENT.test(segment))) return null;
  return {
    prefix,
    moduleSegments: pathSegments,
    receiverMatches: last === receiver,
    groupImport: false,
  };
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
  return importText
    .trim()
    .replace(/^::/, "")
    .split("::")
    .some((segment) => {
      const trimmed = segment.trim();
      if (trimmed === receiver) return true;
      return (
        trimmed.startsWith("{") &&
        trimmed.endsWith("}") &&
        trimmed
          .slice(1, -1)
          .split(",")
          .some((member) => member.trim() === receiver)
      );
    });
}

export function rustImportCandidateSuffix(importText: string, receiver: string): string | null {
  const parsed = parseRustImport(importText, receiver);
  if (!parsed || !parsed.receiverMatches || parsed.moduleSegments.length === 0) return null;
  return [...parsed.moduleSegments, ...(parsed.groupImport ? [receiver] : [])].join("/");
}

export function rustImportCandidatePaths(importText: string, receiver: string, callerFile: string): string[] | null {
  const parsed = parseRustImport(importText, receiver);
  if (!parsed?.receiverMatches) return parsed ? [] : null;
  const suffix = parsed.moduleSegments.join("/");
  const groupMemberSuffix = parsed.groupImport ? `${suffix}/${receiver}` : null;
  const callerDir = callerFile.includes("/") ? callerFile.slice(0, callerFile.lastIndexOf("/")) : "";
  const callerSegments = callerFile.split("/");
  const srcIndex = callerSegments.indexOf("src");
  const crateRoot = srcIndex >= 0 ? callerSegments.slice(0, srcIndex + 1).join("/") : callerDir;
  const moduleRoot = callerDir;
  const parentRoot = moduleRoot.includes("/") ? moduleRoot.slice(0, moduleRoot.lastIndexOf("/")) : "";
  const candidateRoot =
    parsed.prefix === "crate"
      ? crateRoot
      : parsed.prefix === "self"
        ? moduleRoot
        : parsed.prefix === "super"
          ? parentRoot
          : "";
  const candidate = candidateRoot ? `${candidateRoot}/${suffix}` : suffix;
  const groupMemberCandidate =
    groupMemberSuffix === null ? null : candidateRoot ? `${candidateRoot}/${groupMemberSuffix}` : groupMemberSuffix;
  return [
    `${candidate}.rs`,
    `${candidate}/mod.rs`,
    ...(groupMemberCandidate === null ? [] : [`${groupMemberCandidate}.rs`, `${groupMemberCandidate}/mod.rs`]),
  ];
}
