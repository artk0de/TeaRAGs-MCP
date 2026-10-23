#![feature(rustc_private)]
extern crate rustc_driver;

fn main() -> std::process::ExitCode {
    tearags_rust_callsites::cli_main()
}
