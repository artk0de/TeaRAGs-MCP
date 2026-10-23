//! The cargo-side CLI (`tearags-rust-callsites`).
//!
//! Contract (the runner, SPEC §8.3/§8.4, owns the env):
//! - `-V` prints [`crate::banner`] and exits.
//! - cwd is the workspace root; `TEARAGS_CALLSITES_OUT` and `CARGO_TARGET_DIR` are required
//!   (the user's `target/` is never used, so there is no default).
//! - Runs `cargo check --message-format=json --kept_files-going <TEARAGS_CALLSITES_CARGO_ARGS>`
//!   with the driver as `RUSTC_WORKSPACE_WRAPPER`; cargo's own stdout is consumed here,
//!   its stderr passes through.
//! - Writes `<out>/run.json` from cargo's `compiler-artifact` messages (fresh units included)
//!   and deletes every unit file in `<out>/units/` that no listed unit owns (GC for renamed or
//!   removed targets and feature flips).
//! - Exits with cargo's exit code.
//!
//! rustc_plugin's `cli_main` inherits cargo's stdout and passes `-q`, so it cannot collect
//! the message stream; this mirrors its `OnlyWorkspace` path and reuses the plugin's
//! `args` / `modify_cargo`.

use std::{
    collections::{BTreeMap, BTreeSet},
    env, fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Command, ExitCode, Stdio},
};

use rustc_plugin::{RustcPlugin, Utf8Path};
use serde_json::{Value, json};

use crate::{CALLSITES_FORMAT, CallSitesPlugin, DRIVER_BINARY, OUT_ENV, banner};

/// rustc_plugin's CLI→driver env var (`rustc_plugin::plugin::PLUGIN_ARGS`, not re-exported).
const PLUGIN_ARGS_ENV: &str = "PLUGIN_ARGS";

/// One cargo `compiler-artifact` of the run.
struct Artifact {
    /// rmeta stem without `lib`: `<crate><extra-filename>`, matched against `stats.unit`.
    unit: String,
    package_id: String,
    target: String,
    kind: Value,
    test: bool,
    fresh: bool,
    in_workspace: bool,
}

pub fn cli_main() -> ExitCode {
    if env::args().any(|a| a == "-V") {
        println!("{}", banner());
        return ExitCode::SUCCESS;
    }
    match run_cargo_check() {
        Ok(code) => code,
        Err(message) => {
            eprintln!("tearags-rust-callsites: {message}");
            ExitCode::from(2)
        }
    }
}

fn run_cargo_check() -> Result<ExitCode, String> {
    let out_dir = PathBuf::from(env::var(OUT_ENV).map_err(|_| format!("{OUT_ENV} is required"))?);
    let target_dir =
        env::var("CARGO_TARGET_DIR").map_err(|_| "CARGO_TARGET_DIR is required".to_owned())?;
    let plugin = CallSitesPlugin;
    let plugin_args = plugin.args(Utf8Path::new(&target_dir)).args;
    let units_dir = PathBuf::from(&plugin_args.units_dir);
    let root = PathBuf::from(&plugin_args.project_root);
    let driver = env::current_exe()
        .map_err(|e| e.to_string())?
        .with_file_name(DRIVER_BINARY);

    let mut cmd = Command::new("cargo");
    cmd.args(["check", "--message-format=json"])
        .env("RUSTC_WORKSPACE_WRAPPER", &driver)
        .env(
            PLUGIN_ARGS_ENV,
            serde_json::to_string(&plugin_args).map_err(|e| e.to_string())?,
        )
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    plugin.modify_cargo(&mut cmd, &plugin_args);
    let mut cargo = cmd.spawn().map_err(|e| format!("spawn cargo: {e}"))?;

    let mut artifacts: Vec<Artifact> = Vec::new();
    let mut failed: BTreeMap<(String, String, bool), Value> = BTreeMap::new();
    let mut success = false;
    let stdout = cargo.stdout.take().expect("piped stdout");
    let mut stderr = std::io::stderr();
    for line in BufReader::new(stdout).lines() {
        let line = line.map_err(|e| e.to_string())?;
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            let _ = writeln!(stderr, "{line}");
            continue;
        };
        match message["reason"].as_str() {
            Some("compiler-artifact") => artifacts.extend(artifact_of(&message, &root)),
            Some("compiler-message") if message["message"]["level"] == "error" => {
                let key = (
                    message["package_id"]
                        .as_str()
                        .unwrap_or_default()
                        .to_owned(),
                    message["target"]["name"]
                        .as_str()
                        .unwrap_or_default()
                        .to_owned(),
                    message["target"]["test"].as_bool().unwrap_or(false),
                );
                failed.entry(key).or_insert_with(|| {
                    json!({
                        "packageId": message["package_id"],
                        "target": message["target"]["name"],
                        "kind": message["target"]["kind"],
                        "firstError": message["message"]["message"],
                    })
                });
            }
            Some("build-finished") => success = message["success"].as_bool().unwrap_or(false),
            _ => {}
        }
    }
    let cargo_status = cargo.wait().map_err(|e| e.to_string())?;

    let (kept_units, deleted) =
        collect_garbage(&units_dir, &artifacts).map_err(|e| format!("unit GC: {e}"))?;
    let by_unit: BTreeMap<&str, &Artifact> =
        artifacts.iter().map(|a| (a.unit.as_str(), a)).collect();
    let units: Vec<Value> = kept_units
        .iter()
        .map(|(unit_file, unit, krate)| {
            let a = by_unit[unit.as_str()];
            json!({
                "file": unit_file, "unit": unit, "crate": krate, "packageId": a.package_id,
                "target": a.target, "kind": a.kind, "test": a.test, "fresh": a.fresh,
            })
        })
        .collect();
    let owned: BTreeSet<&str> = kept_units
        .iter()
        .map(|(_, unit, _)| unit.as_str())
        .collect();
    // Workspace units cargo reports but no unit file covers: e.g. units/ wiped while target/
    // is warm, so cargo skipped the driver. The runner decides how to recover.
    let missing: Vec<Value> = artifacts
        .iter()
        .filter(|a| a.in_workspace && !owned.contains(a.unit.as_str()))
        .map(|a| json!({"unit": a.unit, "packageId": a.package_id, "target": a.target, "kind": a.kind, "test": a.test}))
        .collect();
    let run_json = json!({
        "format": CALLSITES_FORMAT,
        "banner": banner(),
        "success": success && cargo_status.success(),
        "exitCode": cargo_status.code(),
        "units": units,
        "missing": missing,
        "failed": failed.into_values().collect::<Vec<_>>(),
        "deleted": deleted,
    });
    let run_path = out_dir.join("run.json");
    let tmp = out_dir.join("run.json.tmp");
    fs::write(&tmp, run_json.to_string()).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &run_path).map_err(|e| e.to_string())?;

    Ok(match cargo_status.code() {
        Some(code) => ExitCode::from(u8::try_from(code).unwrap_or(1)),
        None => ExitCode::FAILURE,
    })
}

fn artifact_of(message: &Value, root: &Path) -> Option<Artifact> {
    // The rmeta (check) or rlib; every unit has one under deps/ named lib<crate><extra>.
    let unit = message["filenames"].as_array()?.iter().find_map(|f| {
        let stem = Path::new(f.as_str()?).file_stem()?.to_str()?;
        stem.strip_prefix("lib").map(str::to_owned)
    })?;
    let manifest = message["manifest_path"].as_str().map(PathBuf::from);
    let in_workspace = manifest
        .and_then(|m| m.canonicalize().ok())
        .is_some_and(|m| m.starts_with(root));
    Some(Artifact {
        unit,
        package_id: message["package_id"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
        target: message["target"]["name"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
        kind: message["target"]["kind"].clone(),
        test: message["profile"]["test"].as_bool().unwrap_or(false),
        fresh: message["fresh"].as_bool().unwrap_or(false),
        in_workspace,
    })
}

/// Keeps a unit file pair iff its `stats.unit` is a unit cargo listed this run; deletes the
/// rest (unpaired `.ndjson`/`.stats.json`, stray `.tmp`). Returns the kept_units
/// `(file, unit, crate)` and the sorted deleted file names.
#[allow(clippy::type_complexity)]
fn collect_garbage(
    units_dir: &Path,
    artifacts: &[Artifact],
) -> std::io::Result<(Vec<(String, String, String)>, Vec<String>)> {
    let listed: BTreeSet<&str> = artifacts.iter().map(|a| a.unit.as_str()).collect();
    let mut names: Vec<String> = fs::read_dir(units_dir)?
        .map(|e| e.map(|e| e.file_name().to_string_lossy().into_owned()))
        .collect::<Result<_, _>>()?;
    names.sort();
    let present: BTreeSet<&str> = names.iter().map(String::as_str).collect();
    let mut kept_files: BTreeSet<String> = BTreeSet::new();
    let mut kept_units = Vec::new();
    for name in &names {
        let Some(unit_base) = name.strip_suffix(".stats.json") else {
            continue;
        };
        let ndjson = format!("{unit_base}.ndjson");
        if !present.contains(ndjson.as_str()) {
            continue;
        }
        let stats: Value = fs::read_to_string(units_dir.join(name))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(Value::Null);
        let Some(unit) = stats["unit"].as_str() else {
            continue;
        };
        if listed.contains(unit) {
            kept_units.push((
                ndjson.clone(),
                unit.to_owned(),
                stats["crate"].as_str().unwrap_or_default().to_owned(),
            ));
            kept_files.insert(ndjson);
            kept_files.insert(name.clone());
        }
    }
    let mut deleted = Vec::new();
    for name in names {
        if !kept_files.contains(&name) {
            fs::remove_file(units_dir.join(&name))?;
            deleted.push(name);
        }
    }
    Ok((kept_units, deleted))
}
