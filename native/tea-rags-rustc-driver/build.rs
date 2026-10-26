#![feature(rustc_private)]
extern crate rustc_driver;

#[path = "build_support/source_hash.rs"]
mod source_hash;

use std::path::PathBuf;

// rpath to the pin's target-libdir (librustc_driver), and the sourceHash the `-V` banner
// prints (definition: build_support/source_hash.rs).
fn main() {
    rustc_plugin::build_main();
    let root = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let inputs = source_hash::source_hash_inputs(&root).expect("list sourceHash inputs");
    for dir in source_hash::SOURCE_HASH_DIRS {
        // A directory rerun trigger catches added and removed files.
        println!("cargo::rerun-if-changed={dir}");
    }
    for (rel, _) in &inputs {
        println!("cargo::rerun-if-changed={rel}");
    }
    let hash = source_hash::source_hash(&root).expect("compute sourceHash");
    println!("cargo::rustc-env=TEA_RAGS_RUSTC_DRIVER_SOURCE_HASH={hash}");
}
