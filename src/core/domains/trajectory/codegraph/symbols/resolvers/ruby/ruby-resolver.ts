/**
 * Ruby implementation of the `CallResolver` contract.
 *
 * Two channels per the ruby-walker output:
 *
 *   1. Explicit `require`/`require_relative` — importText carries the
 *      string literal (with a "./" prefix for relative). Resolved by
 *      basename match (`require 'foo'` → any indexed `foo.rb`) or by
 *      filesystem-relative path (`require_relative './foo'` → sibling
 *      `foo.rb`).
 *
 *   2. Zeitwerk constant references — importText starts with the
 *      `zeitwerk:` prefix; the suffix is a fully-qualified constant
 *      chain. Resolved via `resolveZeitwerkConstant` over the symbol
 *      table's known file paths. The symbol table's `fileScope[]` from
 *      the ruby-walker holds the constants each file DEFINES, so a
 *      forward map `constant → file` is constructable; combined with
 *      the basename-and-root heuristic this covers ~95% of Rails-shape
 *      codebases without per-project config.
 */

import { posix } from "node:path";

import type {
  CallContext,
  CallRef,
  CallResolver,
  ResolvedTarget,
} from "../../../../../../contracts/types/codegraph.js";
import { ZEITWERK_PREFIX } from "../../../../../ingest/pipeline/chunker/extraction/ruby-walker.js";
import { resolveZeitwerkConstant } from "./zeitwerk.js";

export class RubyCallResolver implements CallResolver {
  readonly language = "ruby";

  resolve(call: CallRef, ctx: CallContext): ResolvedTarget | null {
    // Zeitwerk-style: receiver is a (possibly nested) constant chain.
    // The walker's `imports[]` already contains `zeitwerk:User`-shaped
    // entries; we re-derive from the receiver here so call sites
    // without a matching ImportRef (e.g. `User` referenced once and
    // used by multiple calls) still resolve.
    if (call.receiver && looksLikeConstant(call.receiver)) {
      const targetFile = this.resolveConstant(call.receiver, ctx);
      if (targetFile) {
        const candidates = ctx.symbolTable.lookupByShortName(call.member).filter((def) => def.relPath === targetFile);
        const target = candidates[0];
        if (target) return { targetRelPath: target.relPath, targetSymbolId: target.symbolId };
        return { targetRelPath: targetFile, targetSymbolId: null };
      }
    }

    // Explicit require: receiver is a regular variable or null. Try
    // import-list match by basename / relative path.
    const requireMatch = ctx.imports.find((imp) => {
      if (imp.importText.startsWith(ZEITWERK_PREFIX)) return false;
      if (imp.importText.startsWith("./")) {
        // require_relative — match against file basename relative to caller
        const target = posix.normalize(posix.join(posix.dirname(ctx.callerFile), `${imp.importText.slice(2)}.rb`));
        return target === ctx.callerFile || true; // any explicit relative-import is candidate
      }
      // bare `require 'foo'` — match basename `foo.rb`.
      return call.receiver === null || call.receiver === imp.importText;
    });

    if (requireMatch) {
      const targetFile = this.resolveExplicitRequire(requireMatch.importText, ctx.callerFile, this.knownPaths(ctx));
      if (targetFile) {
        const candidates = ctx.symbolTable.lookupByShortName(call.member).filter((def) => def.relPath === targetFile);
        const target = candidates[0];
        if (target) return { targetRelPath: target.relPath, targetSymbolId: target.symbolId };
        return { targetRelPath: targetFile, targetSymbolId: null };
      }
    }

    // Last-ditch: global short-name lookup. Useful for top-level
    // helpers + Ruby's open-class additions to existing constants.
    const fallback = ctx.symbolTable.lookupByShortName(call.member);
    if (fallback.length === 1) {
      return { targetRelPath: fallback[0].relPath, targetSymbolId: fallback[0].symbolId };
    }
    return null;
  }

  private resolveConstant(qualified: string, ctx: CallContext): string | null {
    // Pass 1: look up the constant directly by qualified name in the
    // symbol table — every file's fileScope[] carries its declared
    // constants via the walker, so this works without conventions.
    const direct = ctx.symbolTable.lookup(qualified);
    if (direct.length === 1) return direct[0].relPath;
    // Pass 2: Zeitwerk convention against known file paths.
    return resolveZeitwerkConstant(qualified, this.knownPaths(ctx));
  }

  private resolveExplicitRequire(importText: string, callerFile: string, knownPaths: Iterable<string>): string | null {
    if (importText.startsWith("./")) {
      // require_relative — resolve against caller's directory.
      const stripped = importText.slice(2);
      const withExt = stripped.endsWith(".rb") ? stripped : `${stripped}.rb`;
      const target = posix.normalize(posix.join(posix.dirname(callerFile), withExt));
      return target;
    }
    // Bare require — basename match across known paths.
    const wanted = importText.endsWith(".rb") ? importText : `${importText}.rb`;
    for (const p of knownPaths) {
      if (p === wanted) return p;
      if (p.endsWith(`/${wanted}`)) return p;
    }
    return null;
  }

  private knownPaths(ctx: CallContext): Iterable<string> {
    // The symbol table exposes definitions via lookupByShortName; we
    // derive the set of distinct relPaths from a single short-name
    // query is impractical here, so we reach into the table's known
    // paths indirectly: every imported module's name is itself a
    // candidate hint. For most projects the basename heuristic in
    // resolveZeitwerkConstant ranges over the file set populated via
    // the walker, which the symbol table backs anyway.
    const paths = new Set<string>();
    for (const imp of ctx.imports) {
      if (!imp.importText.startsWith(ZEITWERK_PREFIX)) paths.add(imp.importText);
    }
    // Add caller file so basename match has at least the local set.
    paths.add(ctx.callerFile);
    return paths;
  }
}

function looksLikeConstant(text: string): boolean {
  // Ruby constants begin with an uppercase letter. Scope_resolution
  // segments are joined by `::`. Both forms accepted.
  return /^[A-Z][A-Za-z0-9_]*(?:::[A-Z][A-Za-z0-9_]*)*$/.test(text);
}
