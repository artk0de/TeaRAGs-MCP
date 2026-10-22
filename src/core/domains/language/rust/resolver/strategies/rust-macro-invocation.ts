import { CONTINUE, DROP, resolved } from "../../../../../contracts/resolution.js";
import {
  pickSingleCandidate,
  type CallContext,
  type CallRef,
  type SymbolDefinition,
} from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { rustTextIsStdMacro } from "../../vocabulary/std-prelude.js";
import { rustWorkspaceCratesOf } from "../workspace-crates.js";
import {
  RUST_OWN_CRATE_PATH_HEADS,
  rustCallIsMacroInvocation,
  rustImportBindings,
  rustImportIsExternal,
  rustMacroPathIsExternal,
  rustMacroShortNameCandidates,
  type ResolverConfig,
} from "./shared.js";

/** Directories that root a compilation unit of a Cargo package (`src/`, and each target dir). */
const RUST_TARGET_ROOT_DIRS: ReadonlySet<string> = new Set(["src", "tests", "benches", "examples"]);

/**
 * The crate a file compiles into, read off the table: the nearest ancestor
 * directory holding a crate-root file (`lib.rs` / `main.rs` — `crates/core`
 * for `crates/core/flags/config.rs`). With no root indexed, everything up to
 * and including the package's first target directory (`crates/printer/tests`),
 * else the file's own directory (`build.rs`).
 */
function rustMacroCrateKey(relPath: string, ctx: CallContext): string {
  const segments = relPath.split("/");
  for (let depth = segments.length - 1; depth >= 0; depth--) {
    const dir = segments.slice(0, depth).join("/");
    const prefix = dir ? `${dir}/` : "";
    if (ctx.symbolTable.hasFile(`${prefix}lib.rs`) || ctx.symbolTable.hasFile(`${prefix}main.rs`)) return dir;
  }
  const rootIndex = segments.findIndex(
    (segment, index) => index < segments.length - 1 && RUST_TARGET_ROOT_DIRS.has(segment),
  );
  if (rootIndex >= 0) return segments.slice(0, rootIndex + 1).join("/");
  return segments.slice(0, -1).join("/");
}

/**
 * The module path the call site sits in: the caller's own symbol path when
 * known (a module chunk's top-level invocations sit INSIDE that module), else
 * its declaration scope.
 */
function callerModulePath(ctx: CallContext): readonly string[] {
  return ctx.callerSymbolId?.split(/::|#|\./) ?? ctx.callerScope;
}

/** A definition with no recorded line cannot be placed, so it is not ruled out by order. */
function definedBefore(def: SymbolDefinition, call: CallRef): boolean {
  return def.startLine === undefined || def.startLine < call.startLine;
}

/** `macro_rules!` textual scope reaches the defining module and every module nested in it. */
function scopeEncloses(defScope: readonly string[], callerScope: readonly string[]): boolean {
  return defScope.every((segment, index) => callerScope[index] === segment);
}

/** The textually latest definition — a later `macro_rules!` of the same name shadows an earlier one. */
function latest(defs: readonly SymbolDefinition[]): SymbolDefinition {
  return defs.reduce((best, def) => ((def.startLine ?? 0) > (best.startLine ?? 0) ? def : best));
}

/**
 * The `#[macro_export]` macros named `name` that workspace member `crateName`
 * declares (bd tea-rags-mcp-s3i8m.4): an exported macro sits at its crate's
 * root for every dependent, so only `visibility: "public"` definitions under
 * the member's crate-root directories qualify; a non-exported one never crosses
 * the crate boundary. A member that declares no such macro may re-export
 * another crate's (`pub use servo_config::pref;` in `servo`), so the answer
 * widens to every exported macro of the name — still never a non-exported one.
 * `undefined` when `crateName` is no workspace member.
 */
function rustCrateExportedMacros(crateName: string, name: string, ctx: CallContext): SymbolDefinition[] | undefined {
  const crates = rustWorkspaceCratesOf(ctx);
  if (crates?.declares(crateName) !== true) return undefined;
  const rootDirs = crates.rootDirsOf(crateName);
  const exported = rustMacroShortNameCandidates(ctx, name).filter((def) => def.visibility === "public");
  const declared = exported.filter((def) => rootDirs.some((dir) => dir === "" || def.relPath.startsWith(`${dir}/`)));
  return declared.length > 0 ? declared : exported;
}

/**
 * Macro invocations resolve in the MACRO namespace only (bd
 * tea-rags-mcp-s3i8m.2): `format!` never names `fn format`, so a macro
 * invocation is owned here and never reaches the fn passes — every answer is
 * `resolved` or `DROP`, never `continue`. A plain call is not this pass's case.
 *
 * Scoping follows Rust as far as the symbol table can see it:
 *   - bare `name!` — a `macro_rules!` earlier in the caller's file whose module
 *     encloses the caller (textual scope; the latest shadows); else, when a
 *     `use <member>::m` binds the name (nested or renamed) and `<member>` is a
 *     workspace crate, the sole `#[macro_export]` macro of that crate; else,
 *     when a project `use` binds the name, the sole project definition elsewhere;
 *     else declined for a std macro name (the prelude's macro is in scope);
 *     else the sole definition in the caller's crate (`#[macro_use]` modules,
 *     `#[macro_export]` at the crate root);
 *   - `crate::name!` / `$crate::name!` / `self::` / `super::` — the sole
 *     definition in the caller's crate;
 *   - `member::name!` whose head is a workspace crate — the sole
 *     `#[macro_export]` macro of that crate (bd tea-rags-mcp-s3i8m.4);
 *   - `module::name!` / `other_crate::name!` — declined when the head is std or
 *     an external crate, else the sole definition in the caller's crate, then in
 *     the project.
 * Several definitions the scope cannot tell apart decline — no guessed target.
 */
export class RustMacroInvocationSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "macroInvocation";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (!rustCallIsMacroInvocation(call)) return CONTINUE;
    const candidates = rustMacroShortNameCandidates(ctx, call.member);
    const macroDefinition =
      call.receiver === null ? this.bareTarget(call, ctx, candidates) : this.pathTarget(call, ctx, candidates);
    return macroDefinition
      ? resolved({ targetRelPath: macroDefinition.relPath, targetSymbolId: macroDefinition.symbolId })
      : DROP;
  }

  private bareTarget(call: CallRef, ctx: CallContext, candidates: SymbolDefinition[]): SymbolDefinition | null {
    const callerPath = callerModulePath(ctx);
    const textual = candidates.filter(
      (def) => def.relPath === ctx.callerFile && definedBefore(def, call) && scopeEncloses(def.scope, callerPath),
    );
    if (textual.length > 0) return latest(textual);
    const crateExports = this.useBoundCrateExports(call, ctx);
    if (crateExports !== undefined) return pickSingleCandidate(crateExports, this.cfg.mode);
    const elsewhere = candidates.filter((def) => def.relPath !== ctx.callerFile);
    if (this.boundByProjectImport(call, ctx)) return pickSingleCandidate(elsewhere, this.cfg.mode);
    // std's macro is in scope through the prelude; a project namesake in
    // another file shadows it only through a `#[macro_use]` the table cannot
    // see — `writeln!` in `main.rs` is std's, not `man.rs`'s local one.
    if (rustTextIsStdMacro(call.member)) return null;
    const crate = rustMacroCrateKey(ctx.callerFile, ctx);
    const inCrate = elsewhere.filter((def) => rustMacroCrateKey(def.relPath, ctx) === crate);
    return pickSingleCandidate(inCrate, this.cfg.mode);
  }

  private pathTarget(call: CallRef, ctx: CallContext, candidates: SymbolDefinition[]): SymbolDefinition | null {
    const head = call.receiver?.split("::")[0] ?? "";
    const crate = rustMacroCrateKey(ctx.callerFile, ctx);
    const inCrate = candidates.filter((def) => rustMacroCrateKey(def.relPath, ctx) === crate);
    if (RUST_OWN_CRATE_PATH_HEADS.has(head)) return pickSingleCandidate(inCrate, this.cfg.mode);
    // Only `<member>::m!` names the crate-root export; a longer path
    // (`servo::profile_traits::info_event!`) walks a re-exported module.
    const crateExports = call.receiver === head ? rustCrateExportedMacros(head, call.member, ctx) : undefined;
    if (crateExports !== undefined) return pickSingleCandidate(crateExports, this.cfg.mode);
    if (rustMacroPathIsExternal(head, candidates, ctx)) return null;
    return pickSingleCandidate(inCrate.length > 0 ? inCrate : candidates, this.cfg.mode);
  }

  /**
   * The exported macros a `use <crate>::m` binding of the call's name reaches,
   * when `<crate>` is a workspace member — plain, nested or renamed
   * (`use tikv_util::{box_err as be}` binds `be` to `box_err`). `undefined`
   * when no non-glob binding of the name starts at a workspace crate.
   */
  private useBoundCrateExports(call: CallRef, ctx: CallContext): SymbolDefinition[] | undefined {
    for (const imp of ctx.imports) {
      for (const binding of rustImportBindings(imp.importText) ?? []) {
        if (binding.localName !== call.member || binding.globImport || binding.prefix !== null) continue;
        // `use a::b` keeps the bound name as the last segment; a group or renamed
        // binding carries it as `sourceName` (`use a::{b as c}`).
        const path =
          binding.sourceName === null ? binding.moduleSegments : [...binding.moduleSegments, binding.sourceName];
        if (path.length < 2) continue;
        const exports = rustCrateExportedMacros(path[0], path[path.length - 1], ctx);
        if (exports !== undefined) return exports;
      }
    }
    return undefined;
  }

  /** A non-glob project `use` binds the macro's name (`use crate::macros::emit;`). */
  private boundByProjectImport(call: CallRef, ctx: CallContext): boolean {
    return ctx.imports.some(
      (imp) =>
        rustImportBindings(imp.importText)?.some(
          (binding) => binding.localName === call.member && !binding.globImport,
        ) === true && !rustImportIsExternal(imp.importText, ctx),
    );
  }
}
