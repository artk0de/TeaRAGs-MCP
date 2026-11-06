import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileScanner } from "../../../../../src/core/domains/ingest/pipeline/scanner.js";
import { languageIngestIgnoreContribution } from "../../../../../src/core/domains/language/capability/native.js";

/**
 * Directory exclusions that are not a name: a language declares its own ignore
 * contribution (Cargo's `target/`, `cargo vendor` crates identified by their
 * `.cargo-checksum.json`), and a vendored upstream web-platform-tests suite is
 * recognised by its own root files. The walk and `FileScanner#accepts` must
 * agree on every case — the working-tree overlay admits through `accepts`.
 */
describe("FileScanner ignore contributions", () => {
  let root: string;

  const write = (relativePath: string, content = "fn main() {}\n"): void => {
    const target = join(root, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  };

  const scan = async (): Promise<{ walked: string[]; scanner: FileScanner }> => {
    const scanner = new FileScanner({
      supportedExtensions: [".rs", ".js", ".py", ".rb"],
      ignorePatterns: [],
      ignoreContributions: [languageIngestIgnoreContribution()],
    });
    await scanner.loadIgnorePatterns(root);
    const walked = (await scanner.scanDirectory(root)).map((file) => relative(root, file)).sort();
    return { walked, scanner };
  };

  const expectAgreement = (scanner: FileScanner, walked: string[], candidates: string[]): void => {
    for (const candidate of candidates) {
      expect(scanner.accepts(candidate), candidate).toBe(walked.includes(candidate));
    }
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "scanner-ignore-contributions-"));
    write("src/lib.rs");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("prunes Cargo's target directory, OUT_DIR codegen included", async () => {
    write("target/debug/build/foo-1234/out/bindings.rs");
    const { walked, scanner } = await scan();
    expect(walked).toEqual(["src/lib.rs"]);
    expectAgreement(scanner, walked, ["src/lib.rs", "target/debug/build/foo-1234/out/bindings.rs"]);
  });

  it("prunes a cargo-vendored crate by its .cargo-checksum.json marker", async () => {
    // Not named vendor/: the builtin `vendor/` pattern would hide the marker.
    write("third_party/serde/.cargo-checksum.json", '{"files":{}}\n');
    write("third_party/serde/src/lib.rs");
    const { walked, scanner } = await scan();
    expect(walked).toEqual(["src/lib.rs"]);
    expectAgreement(scanner, walked, ["src/lib.rs", "third_party/serde/src/lib.rs"]);
  });

  it("drops a plain vendor/ directory even without a cargo checksum marker", async () => {
    // `vendor/` is a builtin directory ignore (Go modules, Ruby gems), not only a cargo marker.
    write("vendor/engines/billing/app/models/invoice.rb", "class Invoice; end\n");
    write("vendor/patched/src/lib.rs");
    const { walked, scanner } = await scan();
    expect(walked).toEqual(["src/lib.rs"]);
    expectAgreement(scanner, walked, [
      "src/lib.rs",
      "vendor/engines/billing/app/models/invoice.rb",
      "vendor/patched/src/lib.rs",
    ]);
  });

  it("prunes a vendored web-platform-tests root recognised by its own root files", async () => {
    write("tests/wpt/tests/wpt", "#!/usr/bin/env python3\n");
    write("tests/wpt/tests/lint.ignore", "TRAILING WHITESPACE: *\n");
    write("tests/wpt/tests/resources/testharness.js", "function test() {}\n");
    write("tests/wpt/tests/dom/nodes/Node-cloneNode.js", "test(() => {});\n");
    write("tests/wpt/tests/tools/serve/serve.py", "def main(): pass\n");
    write("tests/wpt/mozilla/tests/mozilla/servo_test.js", "test(() => {});\n");
    const { walked, scanner } = await scan();
    expect(walked).toEqual(["src/lib.rs", "tests/wpt/mozilla/tests/mozilla/servo_test.js"]);
    expectAgreement(scanner, walked, [
      "tests/wpt/tests/resources/testharness.js",
      "tests/wpt/tests/dom/nodes/Node-cloneNode.js",
      "tests/wpt/tests/tools/serve/serve.py",
      "tests/wpt/mozilla/tests/mozilla/servo_test.js",
    ]);
  });

  it("keeps a directory merely named wpt that lacks the suite's root files", async () => {
    write("tools/wpt/runner.py", "def run(): pass\n");
    write("tests/wpt/lint.ignore", "TRAILING WHITESPACE: *\n");
    write("tests/wpt/harness.js", "export function run() {}\n");
    const { walked, scanner } = await scan();
    expect(walked).toEqual(["src/lib.rs", "tests/wpt/harness.js", "tools/wpt/runner.py"]);
    expectAgreement(scanner, walked, walked);
  });

  it("never prunes the scanned root itself, even when it carries a marker", async () => {
    write(".cargo-checksum.json", '{"files":{}}\n');
    const { walked, scanner } = await scan();
    expect(walked).toEqual(["src/lib.rs"]);
    expectAgreement(scanner, walked, ["src/lib.rs"]);
  });
});
