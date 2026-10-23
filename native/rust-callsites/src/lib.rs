//! tea-rags rustc call-site driver (research/rustc-driver/SPEC.md).
//!
//! Per call site in the workspace, the callee as the compiler type-checked it, as NDJSON:
//! one `<crateName>-<stableCrateId:016x>.ndjson` (+ `.stats.json`) per compilation unit
//! (SPEC §3). Two binaries:
//!
//! - `tearags-rust-callsites` ([`cli_main`]): runs `cargo check` with the driver as
//!   `RUSTC_WORKSPACE_WRAPPER`, records the unit list in `run.json`, GCs stale unit files.
//! - `tearags-rust-callsites-driver` ([`driver_main`]): the wrapper; runs the collector on
//!   workspace crates and plain rustc on everything else.
#![feature(rustc_private)]

extern crate rustc_driver;
extern crate rustc_hir;
extern crate rustc_interface;
extern crate rustc_middle;
extern crate rustc_span;

mod cli;
mod collect;

use std::{borrow::Cow, fs, process::Command};

use rustc_plugin::{CrateFilter, RustcPlugin, RustcPluginArgs, Utf8Path};
use serde::{Deserialize, Serialize};

pub use cli::cli_main;

/// Version of the `run.json` / unit-file layout this build writes.
pub const CALLSITES_FORMAT: u32 = 3;

/// Name of the wrapper binary, looked up next to the CLI's own executable.
pub const DRIVER_BINARY: &str = "tearags-rust-callsites-driver";

/// Output root: `<out>/units/*.ndjson|*.stats.json` and `<out>/run.json`.
pub const OUT_ENV: &str = "TEARAGS_CALLSITES_OUT";

/// Extra cargo args, whitespace-split; replaces [`DEFAULT_CARGO_ARGS`].
pub const CARGO_ARGS_ENV: &str = "TEARAGS_CALLSITES_CARGO_ARGS";

/// Target selection when [`CARGO_ARGS_ENV`] is unset (`--keep-going` is always added).
pub const DEFAULT_CARGO_ARGS: &str = "--workspace --all-targets";

/// `<version> <pin> <sourceHash>`: what `-V` prints and what the build cache keys on.
pub fn banner() -> String {
    format!(
        "{} {} {}",
        env!("CARGO_PKG_VERSION"),
        rustc_plugin::CHANNEL,
        env!("TEARAGS_CALLSITES_SOURCE_HASH")
    )
}

/// The wrapper entry point (`RUSTC_WORKSPACE_WRAPPER`).
pub fn driver_main() -> std::process::ExitCode {
    rustc_plugin::driver_main(CallSitesPlugin)
}

pub struct CallSitesPlugin;

/// Handed from the CLI to every driver process through rustc_plugin's `PLUGIN_ARGS` env.
#[derive(Serialize, Deserialize, Clone)]
pub struct Args {
    /// Directory the unit files are written to (`<out>/units`).
    pub units_dir: String,
    /// Canonical workspace root; `relPath`s are relative to it, sites outside are dropped.
    pub project_root: String,
}

impl RustcPlugin for CallSitesPlugin {
    type Args = Args;

    fn version(&self) -> Cow<'static, str> {
        banner().into()
    }

    fn driver_name(&self) -> Cow<'static, str> {
        DRIVER_BINARY.into()
    }

    fn args(&self, _target_dir: &Utf8Path) -> RustcPluginArgs<Args> {
        let out_dir = std::env::var(OUT_ENV).unwrap_or_else(|_| panic!("{OUT_ENV} is required"));
        let units_dir = std::path::Path::new(&out_dir).join("units");
        fs::create_dir_all(&units_dir).expect("create units dir");
        let root = std::env::current_dir()
            .and_then(|d| d.canonicalize())
            .expect("canonical workspace root");
        RustcPluginArgs {
            args: Args {
                units_dir: units_dir.to_string_lossy().into_owned(),
                project_root: root.to_string_lossy().into_owned(),
            },
            filter: CrateFilter::OnlyWorkspace,
        }
    }

    fn modify_cargo(&self, cargo: &mut Command, _args: &Args) {
        // Every crate in the graph must be compiled by the driver's own rustc: a corpus
        // rust-toolchain.toml would otherwise pick another rustc for deps and the driver
        // would refuse their rmeta (E0514).
        cargo.env("RUSTUP_TOOLCHAIN", rustc_plugin::CHANNEL);
        cargo.arg("--keep-going");
        let extra = std::env::var(CARGO_ARGS_ENV).unwrap_or_else(|_| DEFAULT_CARGO_ARGS.to_owned());
        cargo.args(extra.split_whitespace());
    }

    fn run(self, compiler_args: Vec<String>, args: Args) -> rustc_interface::interface::Result<()> {
        let unit_suffix = codegen_opt(&compiler_args, "extra-filename")
            .unwrap_or_default()
            .to_owned();
        let mut cb = collect::Callbacks::new(args, unit_suffix);
        rustc_driver::run_compiler(&compiler_args, &mut cb);
        Ok(())
    }
}

/// Value of `-C <key>=v` / `-C<key>=v` in rustc args.
fn codegen_opt<'a>(args: &'a [String], key: &str) -> Option<&'a str> {
    let mut it = args.iter().map(String::as_str);
    while let Some(arg) = it.next() {
        let opt = match arg {
            "-C" | "--codegen" => it.next()?,
            _ => match arg.strip_prefix("-C") {
                Some(rest) => rest,
                None => continue,
            },
        };
        if let Some(v) = opt.strip_prefix(key).and_then(|r| r.strip_prefix('=')) {
            return Some(v);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::codegen_opt;

    fn compiler_args(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn codegen_opt_reads_split_and_joined_forms() {
        assert_eq!(
            codegen_opt(
                &compiler_args(&["-C", "metadata=1", "-C", "extra-filename=-ab"]),
                "extra-filename"
            ),
            Some("-ab")
        );
        assert_eq!(
            codegen_opt(&compiler_args(&["-Cextra-filename=-cd"]), "extra-filename"),
            Some("-cd")
        );
        assert_eq!(
            codegen_opt(&compiler_args(&["--crate-name", "x"]), "extra-filename"),
            None
        );
    }
}
