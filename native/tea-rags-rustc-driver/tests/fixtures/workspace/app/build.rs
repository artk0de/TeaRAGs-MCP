//! Build script: its call sites are a unit of their own (`build_script_build-<hash>`).

fn manifest_name(raw: &str) -> String {
    raw.trim().to_owned()
}

fn main() {
    let name = manifest_name(" fx_app ");
    let mut out = String::new();
    out.push_str(&name);
    println!("cargo:rerun-if-changed=build.rs");
}
