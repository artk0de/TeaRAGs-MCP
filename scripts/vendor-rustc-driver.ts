/**
 * Re-vendor the rustc driver crate's dependencies (`npm run vendor:rustc-driver`).
 *
 * Runs `cargo vendor --versioned-dirs vendor` under the pinned toolchain, then
 * strips each crate's `Cargo.toml.orig` and its checksum key: npm drops `*.orig`
 * from every tarball, and cargo would reject a checksum listing an absent file.
 * The committed vendor tree must be exactly what this script produces; never
 * hand-edit it. Idempotent.
 */
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { findVendorPackagingViolations, stripVendorOrigFiles } from "./lib/rustc-driver-vendor.js";

const crateDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "native", "tea-rags-rustc-driver");
const vendorDir = join(crateDir, "vendor");

// cargo vendor prints the [source] config to stdout; the crate's .cargo/config.toml already carries it.
execFileSync(join(crateDir, "cargo-pinned.sh"), ["vendor", "--versioned-dirs", "vendor"], {
  stdio: ["ignore", "ignore", "inherit"],
});
const stripped = stripVendorOrigFiles(vendorDir);
const violations = findVendorPackagingViolations(vendorDir);
if (violations.length > 0) {
  console.error(`vendor tree still unpackable: ${violations.join(", ")}`);
  process.exit(1);
}
console.log(`vendored ${vendorDir}; stripped Cargo.toml.orig from ${stripped} crate(s)`);
