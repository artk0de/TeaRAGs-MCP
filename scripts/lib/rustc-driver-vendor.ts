/**
 * Post-processing of the rustc driver crate's `cargo vendor` tree so it survives
 * npm packing (`scripts/vendor-rustc-driver.ts`).
 *
 * npm drops every `*.orig` file from a tarball, and cargo refuses a vendored
 * crate whose `.cargo-checksum.json` lists a file that is absent. `cargo vendor`
 * writes a `Cargo.toml.orig` (the pre-normalisation manifest, read by nothing at
 * build time) into each crate, so it is deleted and its checksum key dropped.
 * Cargo verifies only the listed files, so the checksum invariant still holds.
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ORIG_MANIFEST = "Cargo.toml.orig";
const CHECKSUM_FILE = ".cargo-checksum.json";

interface CargoChecksum {
  files: Record<string, string>;
  package?: string | null;
}

/** `<crate>/<file>` entries npm would drop or cargo would reject; empty = packable. */
export function findVendorPackagingViolations(vendorDir: string): string[] {
  const violations: string[] = [];
  for (const crate of crateDirs(vendorDir)) {
    if (existsSync(join(vendorDir, crate, ORIG_MANIFEST))) violations.push(`${crate}/${ORIG_MANIFEST}`);
    const checksum = readChecksum(vendorDir, crate);
    if (checksum === undefined) continue;
    for (const rel of Object.keys(checksum.files)) {
      if (!existsSync(join(vendorDir, crate, rel))) violations.push(`${crate}/${rel}`);
    }
  }
  return violations;
}

/** Deletes each crate's `Cargo.toml.orig` and its checksum key; returns how many crates changed. */
export function stripVendorOrigFiles(vendorDir: string): number {
  let changed = 0;
  for (const crate of crateDirs(vendorDir)) {
    const origPath = join(vendorDir, crate, ORIG_MANIFEST);
    const hadFile = existsSync(origPath);
    if (hadFile) rmSync(origPath);
    const checksum = readChecksum(vendorDir, crate);
    const hadKey = checksum !== undefined && ORIG_MANIFEST in checksum.files;
    if (checksum !== undefined && hadKey) {
      delete checksum.files[ORIG_MANIFEST];
      // cargo vendor's own layout: two-space pretty JSON, trailing newline.
      writeFileSync(join(vendorDir, crate, CHECKSUM_FILE), `${JSON.stringify(checksum, null, 2)}\n`);
    }
    if (hadFile || hadKey) changed += 1;
  }
  return changed;
}

function crateDirs(vendorDir: string): string[] {
  return readdirSync(vendorDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function readChecksum(vendorDir: string, crate: string): CargoChecksum | undefined {
  const path = join(vendorDir, crate, CHECKSUM_FILE);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as CargoChecksum;
}
