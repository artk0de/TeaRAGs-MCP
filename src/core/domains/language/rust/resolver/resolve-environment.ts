/**
 * What the Rust resolver knows about the project beyond its symbol table, for
 * one pass: the workspace crate map (bd tea-rags-mcp-sjego), the external
 * signature table (bd s3i8m.7) and the rustc call-site index (bd s3i8m T6).
 * Carried on `CallContext.languageConfig` as one record;
 * `rustWorkspaceCratesOf` / `rustExternalSignaturesOf` / `rustcCallSitesOf`
 * are its only readers.
 */
import type { CallContext } from "../../../../contracts/types/codegraph.js";
import type { RustCallSiteIndex, RustExternalSignatureTable } from "../../../../contracts/types/language.js";
import type { RustWorkspaceCrateMap } from "./workspace-crates.js";

export class RustResolveEnvironment {
  constructor(
    readonly crates: RustWorkspaceCrateMap | undefined,
    readonly signatures: RustExternalSignatureTable | undefined,
    readonly callSites: RustCallSiteIndex | undefined = undefined,
  ) {}
}

/**
 * The ctx the Rust resolver hands down, carrying the pass's environment in
 * `languageConfig`. Idempotent on the same record, and a no-op without one, so
 * a project with no Cargo.toml and no toolchain allocates nothing.
 */
export function withRustResolveEnvironment(
  ctx: CallContext,
  environment: RustResolveEnvironment | undefined,
): CallContext {
  if (environment === undefined || ctx.languageConfig === environment) return ctx;
  return { ...ctx, languageConfig: environment };
}

/** The external signature table the Rust resolver injected — `undefined` off its entry paths or without sources. */
export function rustExternalSignaturesOf(ctx: CallContext): RustExternalSignatureTable | undefined {
  return ctx.languageConfig instanceof RustResolveEnvironment ? ctx.languageConfig.signatures : undefined;
}

/** The rustc call-site index the Rust resolver injected (bd s3i8m T6) — `undefined` off its entry paths or when none was acquired. */
export function rustcCallSitesOf(ctx: CallContext): RustCallSiteIndex | undefined {
  return ctx.languageConfig instanceof RustResolveEnvironment ? ctx.languageConfig.callSites : undefined;
}
