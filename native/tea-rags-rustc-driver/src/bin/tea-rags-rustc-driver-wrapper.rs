#![feature(rustc_private)]
extern crate rustc_driver;

fn main() -> std::process::ExitCode {
    tea_rags_rustc_driver::driver_main()
}
