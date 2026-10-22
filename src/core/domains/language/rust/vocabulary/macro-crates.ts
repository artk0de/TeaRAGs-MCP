/**
 * External crates whose exported macros the resolver KNOWS (bd
 * tea-rags-mcp-s3i8m.4 B2). A `#[macro_use] extern crate` of one of them
 * provably shadows an earlier macro_use crate's namesake only for the names
 * below; any other external crate exports an unknown set, so its shadowing
 * cannot be proven and a bare macro reaching it declines.
 */

interface RustMacroCrateExports {
  readonly names: ReadonlySet<string>;
  /** Name families no closed list covers (`slog_info`, `info_span`). */
  readonly matches?: (name: string) => boolean;
}

const LOG_LEVELS = ["trace", "debug", "info", "warn", "error"] as const;

const RUST_MACRO_CRATE_EXPORTS: ReadonlyMap<string, RustMacroCrateExports> = new Map<string, RustMacroCrateExports>([
  ["log", { names: new Set([...LOG_LEVELS, "log", "log_enabled"]) }],
  ["slog", { names: new Set([...LOG_LEVELS, "crit", "o"]), matches: (n) => n.startsWith("slog_") }],
  ["slog_global", { names: new Set([...LOG_LEVELS, "crit"]) }],
  ["tracing", { names: new Set([...LOG_LEVELS, "event", "span"]), matches: (n) => n.endsWith("_span") }],
  ["bitflags", { names: new Set(["bitflags"]) }],
  ["lazy_static", { names: new Set(["lazy_static"]) }],
]);

/** Whether the resolver knows the macro set `crateName` exports. */
export function rustMacroCrateIsKnown(crateName: string): boolean {
  return RUST_MACRO_CRATE_EXPORTS.has(crateName);
}

/** Whether known external crate `crateName` exports macro `name`; false for an unknown crate. */
export function rustMacroCrateExports(crateName: string, name: string): boolean {
  const exports = RUST_MACRO_CRATE_EXPORTS.get(crateName);
  if (exports === undefined) return false;
  return exports.names.has(name) || exports.matches?.(name) === true;
}
