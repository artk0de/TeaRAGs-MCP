import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createWorkingTreeFileFilter } from "../../src/bootstrap/factory.js";
import { bindLanguagePresencePorts } from "../../src/core/api/internal/ops/language-presence-ports.js";
import { languageIngestIgnoreContribution } from "../../src/core/domains/language/capability/native.js";

/**
 * The composition root hands the languages' ignore contributions to every
 * scanner it builds, so the working-tree admission rejects what an index run
 * never walks — here a crate vendored by `cargo vendor`.
 */
describe("language ignore contributions reach every composed scanner", () => {
  let root: string;

  const write = (relativePath: string, content = "fn main() {}\n"): void => {
    const target = join(root, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "working-tree-file-filter-"));
    write("src/main.py", "print(1)\n");
    write("vendor/serde/.cargo-checksum.json", '{"files":{}}\n');
    write("vendor/serde/src/lib.rs");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("the working-tree file filter rejects a file inside a cargo-vendored crate", async () => {
    const accepts = await createWorkingTreeFileFilter({
      chunkSize: 2500,
      chunkOverlap: 300,
      supportedExtensions: [".rs", ".py"],
      ignorePatterns: [],
      enableHybridSearch: false,
      quantizationScalar: false,
      turboQuant: false,
    })(root);
    expect(accepts("src/main.py")).toBe(true);
    expect(accepts("vendor/serde/src/lib.rs")).toBe(false);
  });

  it("language presence does not see a language that lives only in a cargo-vendored crate", async () => {
    const ports = bindLanguagePresencePorts({
      countPoints: async () => 0,
      collectionName: "unused",
      absolutePath: root,
      ignorePatterns: [],
      ignoreContributions: [languageIngestIgnoreContribution()],
    });
    expect(await ports.languagesInTree?.(["python", "rust"])).toEqual(["python"]);
  });
});
