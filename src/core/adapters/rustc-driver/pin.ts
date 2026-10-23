/**
 * The one toolchain the rustc call-site driver is built and run with: the channel the
 * `rustc_plugin` dependency is published for (research/rustc-driver/SPEC.md §2, §8.1).
 *
 * Must equal the `channel` of `native/rust-callsites/rust-toolchain.toml` (a unit test
 * asserts it) and the pin field of the driver's `-V` banner (`<version> <pin> <sourceHash>`).
 * Every spawn forces this toolchain and ignores the corpus's own pin. Bumped only with the
 * `rustc_plugin` version, at most once per tea-rags minor release.
 */
export const RUSTC_DRIVER_TOOLCHAIN_PIN = "nightly-2026-05-01";
