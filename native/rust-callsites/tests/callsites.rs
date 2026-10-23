//! Integration test: run the CLI + driver over the fixture workspace (tests/fixtures/workspace,
//! the s3i8m spike fixture) and pin the exact NDJSON rows of SPEC §3 for the call shapes the
//! adapter depends on.
//!
//! Run with the pinned toolchain: `rustup run nightly-2026-05-01 cargo test --offline`
//! (`npm run test:rust-callsites`). The spawn forces that toolchain (PATH/RUSTC/SYSROOT/
//! RUSTUP_TOOLCHAIN) the way the runner does, so a Homebrew cargo on PATH is irrelevant.

#[path = "../build_support/source_hash.rs"]
mod source_hash;

use std::{
    collections::{BTreeSet, HashMap},
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::OnceLock,
};

use serde_json::{Value, json};

const CLI: &str = env!("CARGO_BIN_EXE_tearags-rust-callsites");
const STALE_UNIT: &str = "stale_crate-00000000deadbeef";

fn crate_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn pinned_channel() -> String {
    let toml = fs::read_to_string(crate_root().join("rust-toolchain.toml")).unwrap();
    toml.lines()
        .find_map(|l| {
            l.trim()
                .strip_prefix("channel = ")
                .map(|v| v.trim_matches('"').to_owned())
        })
        .expect("channel in rust-toolchain.toml")
}

fn copy_dir(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let name = entry.file_name();
        if name == "target" {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            copy_dir(&path, &to.join(&name));
        } else {
            fs::copy(&path, to.join(&name)).unwrap();
        }
    }
}

/// The env the runner (T4) assembles: every crate compiled by the pinned rustc.
fn pinned_command(program: &str, cwd: &Path) -> Command {
    let cargo = PathBuf::from(env!("CARGO"));
    let bin = cargo.parent().unwrap().to_path_buf();
    let rustc = bin.join("rustc");
    let sysroot = Command::new(&rustc)
        .args(["--print", "sysroot"])
        .output()
        .unwrap();
    let sysroot = String::from_utf8(sysroot.stdout).unwrap().trim().to_owned();
    let path = format!(
        "{}:{}",
        bin.display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let mut cmd = Command::new(program);
    cmd.current_dir(cwd)
        .env("PATH", path)
        .env("RUSTC", &rustc)
        .env("SYSROOT", sysroot)
        .env("RUSTUP_TOOLCHAIN", pinned_channel())
        .env("CARGO_NET_OFFLINE", "true")
        .env_remove("RUSTC_WRAPPER")
        .env_remove("RUSTC_WORKSPACE_WRAPPER");
    cmd
}

struct Run {
    out_dir: PathBuf,
    output: Output,
    /// run.json of the cold run, and of an immediate warm rerun (every unit fresh).
    cold_run_json: Value,
    warm_run_json: Value,
    /// Deduped on (relPath, line, col, callee), as the reader does.
    rows: Vec<Value>,
    stats: HashMap<String, u64>,
}

fn run() -> &'static Run {
    static RUN: OnceLock<Run> = OnceLock::new();
    RUN.get_or_init(|| {
        let work = std::env::temp_dir().join(format!(
            "tearags-rust-callsites-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&work);
        // The whole fixtures tree: `deps/` holds crates OUTSIDE the workspace root.
        copy_dir(&crate_root().join("tests/fixtures"), &work.join("fixtures"));
        let ws = work.join("fixtures/workspace");
        let out_dir = work.join("out");
        let units = out_dir.join("units");
        fs::create_dir_all(&units).unwrap();
        // A unit from an earlier run whose target no longer exists: GC must delete it.
        fs::write(units.join(format!("{STALE_UNIT}.ndjson")), "{}\n").unwrap();
        fs::write(
            units.join(format!("{STALE_UNIT}.stats.json")),
            json!({"unit": "stale_crate-1"}).to_string(),
        )
        .unwrap();
        let invoke = || {
            pinned_command(CLI, &ws)
                .env("CARGO_TARGET_DIR", work.join("target"))
                .env("TEARAGS_CALLSITES_OUT", &out_dir)
                .output()
                .unwrap()
        };
        let read_run_json = || -> Value {
            fs::read_to_string(out_dir.join("run.json"))
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or(Value::Null)
        };
        let output = invoke();
        let cold_run_json = read_run_json();
        assert!(invoke().status.success(), "warm rerun failed");
        let warm_run_json = read_run_json();
        let mut seen = BTreeSet::new();
        let mut rows = Vec::new();
        let mut stats: HashMap<String, u64> = HashMap::new();
        let mut names: Vec<_> = fs::read_dir(&units)
            .map(|d| d.map(|e| e.unwrap().path()).collect())
            .unwrap_or_default();
        names.sort();
        for path in names {
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            if name.ends_with(".stats.json") {
                let s: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
                for pair in s["stats"].as_array().into_iter().flatten() {
                    *stats
                        .entry(pair[0].as_str().unwrap().to_owned())
                        .or_default() += pair[1].as_u64().unwrap();
                }
            } else if name.ends_with(".ndjson") {
                for line in fs::read_to_string(&path).unwrap().lines() {
                    let r: Value = serde_json::from_str(line).unwrap();
                    let key = (
                        r["relPath"].to_string(),
                        r["line"].to_string(),
                        r["col"].to_string(),
                        r["callee"].to_string(),
                    );
                    if seen.insert(key) {
                        rows.push(r);
                    }
                }
            }
        }
        Run {
            out_dir,
            output,
            cold_run_json,
            warm_run_json,
            rows,
            stats,
        }
    })
}

const MACRO_INVOCATION: &str = "macroInvocation";

/// Call-site rows (`source` / `macro`) on a line; macro-invocation rows are pinned apart.
fn rows_at(rel_path: &str, line: u64) -> Vec<&'static Value> {
    run()
        .rows
        .iter()
        .filter(|r| {
            r["relPath"] == rel_path && r["line"] == line && r["origin"] != MACRO_INVOCATION
        })
        .collect()
}

fn invocations() -> impl Iterator<Item = &'static Value> {
    run()
        .rows
        .iter()
        .filter(|r| r["origin"] == MACRO_INVOCATION)
}

fn invocation_at(rel_path: &str, line: u64, col: u64) -> &'static Value {
    let hits: Vec<_> = invocations()
        .filter(|r| r["relPath"] == rel_path && r["line"] == line && r["col"] == col)
        .collect();
    assert_eq!(
        hits.len(),
        1,
        "expected exactly one macro invocation at {rel_path}:{line}:{col}, got {hits:#?}"
    );
    hits[0]
}

fn invocation(
    rel: &str,
    line: u64,
    col: u64,
    name: &str,
    def_path: &str,
    krate: &str,
    def: Option<(&str, u64)>,
) -> Value {
    json!({
        "relPath": rel, "line": line, "col": col, "origin": MACRO_INVOCATION, "macro": name,
        "macroDefPath": def_path, "calleeCrate": krate, "inProject": def.is_some(),
        "defRelPath": def.map(|d| d.0), "defLine": def.map(|d| d.1),
    })
}

fn row_at(rel_path: &str, line: u64, col: u64) -> &'static Value {
    let hits: Vec<_> = rows_at(rel_path, line)
        .into_iter()
        .filter(|r| r["col"] == col)
        .collect();
    assert_eq!(
        hits.len(),
        1,
        "expected exactly one row at {rel_path}:{line}:{col}, got {hits:#?}"
    );
    hits[0]
}

#[allow(clippy::too_many_arguments)]
fn site(
    rel: &str,
    line: u64,
    col: u64,
    call_kind: &str,
    callee: &str,
    krate: &str,
    def_kind: &str,
) -> Value {
    json!({
        "relPath": rel, "line": line, "col": col, "origin": "source", "macro": null,
        "callKind": call_kind, "callee": callee, "calleeCrate": krate, "defKind": def_kind,
        "traitPath": null, "implSelfType": null, "resolvedImpl": null, "implIsDerived": false,
        "inProject": false, "defRelPath": null, "defLine": null,
    })
}

fn with(mut base: Value, patch: Value) -> Value {
    for (k, v) in patch.as_object().unwrap() {
        base[k] = v.clone();
    }
    base
}

#[test]
fn cli_run_succeeds() {
    let out = &run().output;
    assert!(
        out.status.success(),
        "cli failed: {}\n{}",
        String::from_utf8_lossy(&out.stderr),
        String::from_utf8_lossy(&out.stdout)
    );
}

#[test]
fn version_banner_prints_version_pin_and_source_hash() {
    let out = Command::new(CLI).arg("-V").output().unwrap();
    assert!(out.status.success());
    let banner = String::from_utf8(out.stdout).unwrap();
    let parts: Vec<&str> = banner.trim().split(' ').collect();
    let expected_hash = source_hash::source_hash(&crate_root()).unwrap();
    assert_eq!(
        parts,
        vec![
            env!("CARGO_PKG_VERSION"),
            pinned_channel().as_str(),
            expected_hash.as_str()
        ]
    );
}

#[test]
fn source_hash_sha256_matches_fips_vectors() {
    let digest = |s: &str| {
        let mut h = source_hash::Sha256::new();
        h.update(s.as_bytes());
        source_hash::hex(&h.finish())
    };
    assert_eq!(
        digest(""),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert_eq!(
        digest("abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    assert_eq!(
        digest("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
        "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
    );
}

#[test]
fn ufcs_call_resolves_to_the_impl() {
    let expected = with(
        site(
            "app/src/main.rs",
            21,
            19,
            "path",
            "fx_core::Store::get",
            "fx_core",
            "assocFn",
        ),
        json!({"traitPath": "fx_core::Store", "resolvedImpl": "<fx_core::MemStore as fx_core::Store>::get",
               "inProject": true, "defRelPath": "core/src/lib.rs", "defLine": 24}),
    );
    assert_eq!(row_at("app/src/main.rs", 21, 19), &expected);
}

#[test]
fn qualified_ufcs_default_method_keeps_the_trait_declaration() {
    let expected = with(
        site(
            "app/src/main.rs",
            22,
            33,
            "path",
            "fx_core::Store::describe",
            "fx_core",
            "assocFn",
        ),
        json!({"traitPath": "fx_core::Store", "inProject": true, "defRelPath": "core/src/lib.rs", "defLine": 5}),
    );
    assert_eq!(row_at("app/src/main.rs", 22, 33), &expected);
}

#[test]
fn dyn_trait_call_has_no_resolved_impl() {
    let expected = with(
        site(
            "app/src/main.rs",
            9,
            6,
            "method",
            "fx_core::Store::describe",
            "fx_core",
            "assocFn",
        ),
        json!({"traitPath": "fx_core::Store", "inProject": true, "defRelPath": "core/src/lib.rs", "defLine": 5}),
    );
    assert_eq!(row_at("app/src/main.rs", 9, 6), &expected);
}

#[test]
fn generic_bound_call_has_no_resolved_impl() {
    let expected = with(
        site(
            "app/src/main.rs",
            5,
            6,
            "method",
            "fx_core::Store::get",
            "fx_core",
            "assocFn",
        ),
        json!({"traitPath": "fx_core::Store", "inProject": true, "defRelPath": "core/src/lib.rs", "defLine": 4}),
    );
    assert_eq!(row_at("app/src/main.rs", 5, 6), &expected);
}

#[test]
fn inherent_associated_fn_carries_impl_self_type() {
    let expected = with(
        site(
            "app/src/main.rs",
            13,
            30,
            "path",
            "fx_core::MemStore::new",
            "fx_core",
            "assocFn",
        ),
        json!({"implSelfType": "fx_core::MemStore", "inProject": true, "defRelPath": "core/src/lib.rs", "defLine": 15}),
    );
    assert_eq!(row_at("app/src/main.rs", 13, 30), &expected);
}

#[test]
fn derived_clone_is_flagged_implis_derived() {
    let expected = with(
        site(
            "app/src/main.rs",
            17,
            14,
            "method",
            "std::clone::Clone::clone",
            "core",
            "assocFn",
        ),
        json!({"traitPath": "std::clone::Clone", "resolvedImpl": "<fx_core::Point as std::clone::Clone>::clone",
               "implIsDerived": true, "inProject": true, "defRelPath": "core/src/lib.rs", "defLine": 29}),
    );
    assert_eq!(row_at("app/src/main.rs", 17, 14), &expected);
}

#[test]
fn derive_bodies_are_dropped() {
    let phantom: Vec<_> = (29..=33)
        .flat_map(|l| rows_at("core/src/lib.rs", l))
        .collect();
    assert!(
        phantom.is_empty(),
        "derive output produced rows: {phantom:#?}"
    );
    assert!(run().stats.get("drop.deriveBody").copied().unwrap_or(0) > 0);
}

#[test]
fn macro_rules_body_call_is_origin_macro_at_the_macro_name() {
    let expected = with(
        site("core/src/lib.rs", 56, 4, "path", "helper", "fx_core", "fn"),
        json!({"origin": "macro", "macro": "twice", "inProject": true, "defRelPath": "core/src/lib.rs", "defLine": 51}),
    );
    assert_eq!(row_at("core/src/lib.rs", 56, 4), &expected);
}

#[test]
fn local_macro_rules_invocation_names_its_definition() {
    // A local crate's def path prints unprefixed (`helper`, `total`), so does its macro.
    let def = Some(("core/src/lib.rs", 60));
    assert_eq!(
        invocation_at("core/src/lib.rs", 72, 4),
        &invocation("core/src/lib.rs", 72, 4, "my_log", "my_log", "fx_core", def)
    );
    assert_eq!(
        invocation_at("core/src/lib.rs", 56, 4),
        &invocation(
            "core/src/lib.rs",
            56,
            4,
            "twice",
            "twice",
            "fx_core",
            Some(("core/src/lib.rs", 45))
        )
    );
}

#[test]
fn cross_crate_path_invocation_sits_at_the_macro_name_token() {
    assert_eq!(
        invocation_at("app/src/main.rs", 32, 13),
        &invocation(
            "app/src/main.rs",
            32,
            13,
            "my_log",
            "fx_core::my_log",
            "fx_core",
            Some(("core/src/lib.rs", 60))
        )
    );
}

#[test]
fn std_macro_invocations_are_external() {
    let external = |line, col, name: &str| {
        invocation(
            "core/src/lib.rs",
            line,
            col,
            name,
            &format!("std::{name}"),
            "core",
            None,
        )
    };
    assert_eq!(
        invocation_at("core/src/lib.rs", 71, 14),
        &external(71, 14, "matches")
    );
    assert_eq!(
        invocation_at("core/src/lib.rs", 73, 9),
        &external(73, 9, "write")
    );
    // `std::matches!` is core's macro re-exported by std: the definition, not the re-export.
    assert_eq!(
        invocation_at("core/src/lib.rs", 73, 30),
        &external(73, 30, "matches")
    );
}

#[test]
fn macro_invocations_inside_expansions_are_not_rows() {
    // `my_log!` expands to `format!` (body line 62), `write!` to `format_args!`: neither is a
    // site the user wrote. The `format!` the user wrote in `Store::describe` is one.
    let nested: Vec<_> = invocations()
        .filter(|r| r["macro"] == "format_args" || (r["macro"] == "format" && r["line"] != 6))
        .collect();
    assert!(nested.is_empty(), "nested invocations emitted: {nested:#?}");
    assert_eq!(
        invocation_at("core/src/lib.rs", 6, 8)["macroDefPath"],
        "std::format"
    );
    let mut sites = BTreeSet::new();
    for r in invocations() {
        assert!(
            sites.insert((
                r["relPath"].to_string(),
                r["line"].to_string(),
                r["col"].to_string()
            )),
            "two invocation rows at one site: {r}"
        );
    }
}

#[test]
fn macro_argument_call_is_origin_source() {
    let expected = with(
        site(
            "core/src/lib.rs",
            56,
            13,
            "method",
            "core::num::<impl i64>::abs",
            "core",
            "assocFn",
        ),
        json!({"implSelfType": "i64"}),
    );
    assert_eq!(row_at("core/src/lib.rs", 56, 13), &expected);
    let println_arg = with(
        site("app/src/main.rs", 18, 36, "path", "total", "fx_app", "fn"),
        json!({"inProject": true, "defRelPath": "app/src/main.rs", "defLine": 3}),
    );
    assert_eq!(row_at("app/src/main.rs", 18, 36), &println_arg);
}

#[test]
fn non_ascii_line_columns_are_utf16() {
    // `    let _ = "é→x".len(); let _ = "🦀".chars().count();`
    // é/→ are one UTF-16 unit (2/3 bytes), 🦀 is two (4 bytes, one char).
    assert_eq!(
        row_at("app/src/main.rs", 26, 18),
        &with(
            site(
                "app/src/main.rs",
                26,
                18,
                "method",
                "core::str::<impl str>::len",
                "core",
                "assocFn"
            ),
            json!({"implSelfType": "str"})
        )
    );
    assert_eq!(
        row_at("app/src/main.rs", 26, 38),
        &with(
            site(
                "app/src/main.rs",
                26,
                38,
                "method",
                "core::str::<impl str>::chars",
                "core",
                "assocFn"
            ),
            json!({"implSelfType": "str"})
        )
    );
    assert_eq!(
        row_at("app/src/main.rs", 26, 46),
        &with(
            site(
                "app/src/main.rs",
                26,
                46,
                "method",
                "std::iter::Iterator::count",
                "core",
                "assocFn"
            ),
            json!({"traitPath": "std::iter::Iterator", "resolvedImpl": "<std::str::Chars<'a> as std::iter::Iterator>::count"})
        )
    );
}

#[test]
fn question_mark_desugaring_is_dropped() {
    let line15: Vec<_> = rows_at("app/src/main.rs", 15)
        .into_iter()
        .map(|r| r["callee"].as_str().unwrap())
        .collect();
    assert_eq!(line15, vec!["fx_core::parse_num"]);
    assert!(run().stats.get("drop.desugaring").copied().unwrap_or(0) > 0);
}

/// An indirect-callee row (RESIDUAL R4): the callee token is a local binding, a param or a
/// field whose TYPE is a closure, fn pointer or Fn-bound param — no definition to name.
fn indirect(line: u64, col: u64, name: &str, def_kind: &str) -> Value {
    with(
        site("core/src/lib.rs", line, col, "local", name, "", def_kind),
        json!({"calleeCrate": null}),
    )
}

#[test]
fn local_binding_of_a_fn_item_resolves_to_the_item() {
    let expected = with(
        site(
            "core/src/lib.rs",
            108,
            4,
            "local",
            "Stamp::new",
            "fx_core",
            "assocFn",
        ),
        json!({"implSelfType": "Stamp", "inProject": true, "defRelPath": "core/src/lib.rs", "defLine": 79}),
    );
    assert_eq!(row_at("core/src/lib.rs", 108, 4), &expected);
}

#[test]
fn local_closure_call_is_an_indirect_closure_row() {
    assert_eq!(
        row_at("core/src/lib.rs", 107, 4),
        &indirect(107, 4, "insert", "closure")
    );
}

#[test]
fn fn_bound_params_are_indirect_fn_param_rows() {
    assert_eq!(
        row_at("core/src/lib.rs", 96, 4),
        &indirect(96, 4, "cb", "fnParam")
    );
    assert_eq!(
        row_at("core/src/lib.rs", 96, 11),
        &indirect(96, 11, "by_ref", "fnParam")
    );
    assert_eq!(
        row_at("core/src/lib.rs", 100, 4),
        &indirect(100, 4, "cb", "fnParam")
    );
}

#[test]
fn pattern_bound_shared_trait_object_is_an_indirect_fn_param_row() {
    // `Some(f)` over `&Option<Arc<dyn Fn>>`: the call autoderefs through `Arc`.
    assert_eq!(
        row_at("core/src/lib.rs", 113, 15),
        &indirect(113, 15, "f", "fnParam")
    );
}

#[test]
fn field_callee_sits_at_the_field_name_token() {
    assert_eq!(
        row_at("core/src/lib.rs", 91, 14),
        &indirect(91, 14, "f", "fnPointer")
    );
    assert_eq!(
        row_at("core/src/lib.rs", 91, 28),
        &indirect(91, 28, "g", "fnParam")
    );
}

/// The `defExpansion` of a definition a macro generated (format 4).
fn def_expansion(kind: &str, name: &str, def_path: &str, def: Option<(&str, u64, &str)>) -> Value {
    json!({
        "kind": kind, "macro": name, "macroDefPath": def_path, "macroInProject": def.is_some(),
        "macroDefRelPath": def.map(|d| d.0), "macroDefLine": def.map(|d| d.1),
        "macroDefName": def.map(|d| d.2),
    })
}

#[test]
fn dependency_derive_definition_carries_its_expansion() {
    let row = row_at("core/src/lib.rs", 141, 27);
    assert_eq!(
        row["resolvedImpl"],
        "<Failure as std::convert::From<i64>>::from"
    );
    assert_eq!(row["implIsDerived"], false);
    assert_eq!(
        row["defExpansion"],
        def_expansion("derive", "Fail", "fx_dep_derive::Fail", None)
    );
}

#[test]
fn workspace_proc_macro_derive_definition_names_the_macro_function() {
    let row = row_at("core/src/lib.rs", 142, 28);
    assert_eq!(row["callee"], "Settings::configure");
    assert_eq!(
        row["defExpansion"],
        def_expansion(
            "derive",
            "Configurable",
            "fx_derive::Configurable",
            Some(("derive/src/lib.rs", 5, "derive_configurable"))
        )
    );
}

#[test]
fn project_macro_rules_definition_names_the_macro() {
    let row = row_at("core/src/lib.rs", 143, 32);
    assert_eq!(row["callee"], "BoxObserver::new");
    assert_eq!(row["defLine"], 129);
    assert_eq!(
        row["defExpansion"],
        def_expansion(
            "bang",
            "observer",
            "observer",
            Some(("core/src/lib.rs", 125, "observer"))
        )
    );
}

#[test]
fn dependency_macro_rules_definition_is_external_with_its_expansion() {
    let row = row_at("core/src/lib.rs", 144, 22);
    assert_eq!(row["callee"], "Meta::contains");
    assert_eq!(row["calleeCrate"], "fx_core");
    assert_eq!(row["inProject"], false);
    assert_eq!(
        row["defExpansion"],
        def_expansion("bang", "flagset", "fx_dep_macros::flagset", None)
    );
}

#[test]
fn only_macro_generated_definitions_carry_an_expansion() {
    let generated: BTreeSet<(u64, u64)> = run()
        .rows
        .iter()
        .filter(|r| r.get("defExpansion").is_some())
        .map(|r| (r["line"].as_u64().unwrap(), r["col"].as_u64().unwrap()))
        .collect();
    assert_eq!(
        generated,
        [(141, 27), (142, 28), (143, 32), (144, 22)]
            .into_iter()
            .collect()
    );
}

#[test]
fn every_row_has_exactly_the_contract_fields() {
    let expected: BTreeSet<&str> = [
        "relPath",
        "line",
        "col",
        "origin",
        "macro",
        "callKind",
        "callee",
        "calleeCrate",
        "defKind",
        "traitPath",
        "implSelfType",
        "resolvedImpl",
        "implIsDerived",
        "inProject",
        "defRelPath",
        "defLine",
    ]
    .into_iter()
    .collect();
    let invocation_fields: BTreeSet<&str> = [
        "relPath",
        "line",
        "col",
        "origin",
        "macro",
        "macroDefPath",
        "calleeCrate",
        "inProject",
        "defRelPath",
        "defLine",
    ]
    .into_iter()
    .collect();
    assert!(!run().rows.is_empty());
    for r in &run().rows {
        let keys: BTreeSet<&str> = r.as_object().unwrap().keys().map(String::as_str).collect();
        let contract = if r["origin"] == MACRO_INVOCATION {
            &invocation_fields
        } else {
            &expected
        };
        // `defExpansion` (format 4) is present only on a definition a macro generated.
        let keys: BTreeSet<&str> = keys.into_iter().filter(|k| *k != "defExpansion").collect();
        assert_eq!(&keys, contract, "row {r}");
    }
}

#[test]
fn run_json_lists_every_unit_and_stale_units_are_deleted() {
    let units_dir = run().out_dir.join("units");
    let run_json = &run().cold_run_json;
    assert_eq!(run_json["format"], 4);
    assert_eq!(run_json["success"], true);
    assert_eq!(run_json["failed"], json!([]));
    assert_eq!(run_json["missing"], json!([]));
    let listed: BTreeSet<String> = run_json["units"]
        .as_array()
        .unwrap()
        .iter()
        .map(|u| u["file"].as_str().unwrap().to_owned())
        .collect();
    let on_disk: BTreeSet<String> = fs::read_dir(&units_dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".ndjson"))
        .collect();
    assert_eq!(listed, on_disk);
    // lib + test harness of fx_core, bin + test harness of fx_app; fx_derive's check, test
    // harness, and the host build fx_core's derive loads.
    assert_eq!(listed.len(), 7, "{listed:?}");
    let crates: BTreeSet<&str> = run_json["units"]
        .as_array()
        .unwrap()
        .iter()
        .map(|u| u["crate"].as_str().unwrap())
        .collect();
    assert_eq!(
        crates,
        ["fx_app", "fx_core", "fx_derive"].into_iter().collect()
    );
    assert!(!units_dir.join(format!("{STALE_UNIT}.ndjson")).exists());
    assert!(!units_dir.join(format!("{STALE_UNIT}.stats.json")).exists());
    assert_eq!(
        run_json["deleted"],
        json!([
            format!("{STALE_UNIT}.ndjson"),
            format!("{STALE_UNIT}.stats.json")
        ])
    );
}

#[test]
fn warm_rerun_keeps_fresh_units() {
    let (cold, warm) = (&run().cold_run_json, &run().warm_run_json);
    let files = |v: &Value| -> Vec<String> {
        v["units"]
            .as_array()
            .unwrap()
            .iter()
            .map(|u| u["file"].as_str().unwrap().to_owned())
            .collect()
    };
    assert_eq!(files(warm), files(cold));
    assert!(
        warm["units"]
            .as_array()
            .unwrap()
            .iter()
            .all(|u| u["fresh"] == true),
        "{warm}"
    );
    assert_eq!(warm["deleted"], json!([]));
    assert_eq!(warm["missing"], json!([]));
}
