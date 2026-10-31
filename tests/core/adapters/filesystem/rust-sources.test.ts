import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { listRustSources } from "../../../../src/core/adapters/filesystem/rust-sources.js";

describe("listRustSources", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function makeTree(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "tea-rags-rust-sources-"));
    roots.push(root);
    for (const [relPath, content] of Object.entries(files)) {
      const absolute = join(root, relPath);
      mkdirSync(join(absolute, ".."), { recursive: true });
      writeFileSync(absolute, content);
    }
    return root;
  }

  it("lists nested .rs files with repo-relative paths and stat stamps, skipping target, node_modules and dot-directories", () => {
    const root = makeTree({
      "Cargo.toml": "",
      "src/main.rs": "fn main() {}",
      "src/util/mod.rs": "pub fn f() {}",
      "src/util/notes.txt": "not rust",
      "target/debug/gen.rs": "skipped",
      "node_modules/pkg/lib.rs": "skipped",
      ".hidden/secret.rs": "skipped",
    });

    const stamps = listRustSources(root);

    expect(stamps.map((stamp) => stamp.relPath).sort()).toEqual(["src/main.rs", "src/util/mod.rs"]);
    const main = stamps.find((stamp) => stamp.relPath === "src/main.rs");
    expect(main?.size).toBe("fn main() {}".length);
    expect(main?.mtimeMs).toBeGreaterThan(0);
  });

  it("returns an empty list for a root that cannot be read", () => {
    expect(listRustSources(join(tmpdir(), "tea-rags-rust-sources-does-not-exist"))).toEqual([]);
  });
});
