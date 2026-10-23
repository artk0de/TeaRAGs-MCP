/**
 * The rustc driver crate ships in the npm package and builds offline from its
 * vendored dependencies. npm always drops `*.orig` files from a tarball, and
 * cargo refuses a vendored crate whose `.cargo-checksum.json` lists a file that
 * is absent — so the vendor tree must carry no `Cargo.toml.orig` and no
 * checksum key without its file (`scripts/vendor-rustc-driver.ts` produces it).
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { findVendorPackagingViolations, stripVendorOrigFiles } from "../../scripts/lib/rustc-driver-vendor.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CRATE = "native/tea-rags-rustc-driver";
const VENDOR = join(ROOT, CRATE, "vendor");

/** Every file under `dir`, `/`-separated and relative to it. */
function walk(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(dir, rel));
    else out.push(rel);
  }
  return out;
}

describe("vendored rustc driver dependencies survive npm packing", () => {
  it("carries no *.orig file (npm drops them from every tarball)", () => {
    expect(walk(VENDOR).filter((rel) => rel.endsWith(".orig"))).toEqual([]);
  });

  it("lists in every .cargo-checksum.json only files that exist", () => {
    const missing: string[] = [];
    for (const crate of readdirSync(VENDOR)) {
      const checksum = join(VENDOR, crate, ".cargo-checksum.json");
      if (!existsSync(checksum)) continue;
      const { files } = JSON.parse(readFileSync(checksum, "utf8")) as { files: Record<string, string> };
      for (const rel of Object.keys(files)) {
        if (!existsSync(join(VENDOR, crate, rel))) missing.push(`${crate}/${rel}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("is shipped by package.json files, without target/ and tests/", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { files: string[] };
    expect(pkg.files).toEqual(expect.arrayContaining([`${CRATE}/`, `!${CRATE}/target/`, `!${CRATE}/tests/`]));
  });
});

describe("stripVendorOrigFiles", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function fixture(): string {
    dir = mkdtempSync(join(tmpdir(), "rustc-driver-vendor-"));
    const crate = join(dir, "a-1.0.0");
    mkdirSync(crate);
    writeFileSync(join(crate, "Cargo.toml"), "x");
    writeFileSync(join(crate, "Cargo.toml.orig"), "y");
    const checksum = { files: { "Cargo.toml": "h1", "Cargo.toml.orig": "h2" }, package: "p" };
    writeFileSync(join(crate, ".cargo-checksum.json"), `${JSON.stringify(checksum, null, 2)}\n`);
    return dir;
  }

  it("deletes Cargo.toml.orig and drops its checksum key, keeping cargo's JSON layout", () => {
    const vendor = fixture();
    expect(findVendorPackagingViolations(vendor)).toEqual(["a-1.0.0/Cargo.toml.orig"]);

    expect(stripVendorOrigFiles(vendor)).toBe(1);

    expect(existsSync(join(vendor, "a-1.0.0", "Cargo.toml.orig"))).toBe(false);
    expect(readFileSync(join(vendor, "a-1.0.0", ".cargo-checksum.json"), "utf8")).toBe(
      `${JSON.stringify({ files: { "Cargo.toml": "h1" }, package: "p" }, null, 2)}\n`,
    );
    expect(findVendorPackagingViolations(vendor)).toEqual([]);
  });

  it("is idempotent", () => {
    const vendor = fixture();
    stripVendorOrigFiles(vendor);
    expect(stripVendorOrigFiles(vendor)).toBe(0);
  });
});
