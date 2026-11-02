import { describe, expect, it } from "vitest";

import { findRustDeclaredTestFiles } from "../../../../../src/core/domains/language/rust/declared-test-files.js";

/** Run the resolver over an in-memory project: every key is a file of the run. */
async function declaredTestFiles(files: Record<string, string>): Promise<string[]> {
  const found = await findRustDeclaredTestFiles({
    relativePaths: Object.keys(files),
    readFile: async (relativePath) => files[relativePath],
  });
  return [...found].sort();
}

describe("findRustDeclaredTestFiles", () => {
  it("resolves a `#[cfg(test)] mod x;` in lib.rs to the sibling file", async () => {
    expect(
      await declaredTestFiles({
        "crates/searcher/src/lib.rs": "mod searcher;\n#[cfg(test)]\nmod testutil;\n",
        "crates/searcher/src/searcher.rs": "pub struct Searcher;\n",
        "crates/searcher/src/testutil.rs": "pub struct RegexMatcher;\n",
      }),
    ).toEqual(["crates/searcher/src/testutil.rs"]);
  });

  it("resolves a declaration in a non-mod-rs file under the file's own directory", async () => {
    expect(
      await declaredTestFiles({
        "src/main.rs": "mod foo;\n",
        "src/foo.rs": "#[cfg(test)] mod testutil;\n",
        "src/foo/testutil.rs": "",
        "src/testutil.rs": "",
      }),
    ).toEqual(["src/foo/testutil.rs"]);
  });

  it("resolves a declaration in mod.rs to the module's directory", async () => {
    expect(
      await declaredTestFiles({
        "src/lib.rs": "mod parser;\n",
        "src/parser/mod.rs": "#[cfg(test)]\nmod fixtures;\n",
        "src/parser/fixtures.rs": "",
      }),
    ).toEqual(["src/parser/fixtures.rs"]);
  });

  it("falls back to `<dir>/x/mod.rs` when `<dir>/x.rs` is not a file of the run", async () => {
    expect(
      await declaredTestFiles({
        "src/lib.rs": "#[cfg(test)]\nmod testutil;\n",
        "src/testutil/mod.rs": "",
      }),
    ).toEqual(["src/testutil/mod.rs"]);
  });

  it("honours `#[path]` at file level, relative to the declaring file's directory", async () => {
    expect(
      await declaredTestFiles({
        "src/foo.rs": '#[cfg(test)]\n#[path = "support/x.rs"]\nmod helpers;\n',
        "src/support/x.rs": "",
        "src/foo/helpers.rs": "",
      }),
    ).toEqual(["src/support/x.rs"]);
  });

  it("resolves a declaration nested in inline modules under the inline module path", async () => {
    expect(
      await declaredTestFiles({
        "src/lib.rs": "mod a {\n    #[cfg(test)]\n    mod b;\n}\n",
        "src/a/b.rs": "",
        "src/b.rs": "",
      }),
    ).toEqual(["src/a/b.rs"]);
  });

  it("takes every body-less module inside a test-only inline module", async () => {
    expect(
      await declaredTestFiles({
        "src/lib.rs": "#[cfg(test)]\nmod tests {\n    mod support;\n}\n",
        "src/tests/support.rs": "",
      }),
    ).toEqual(["src/tests/support.rs"]);
  });

  it("closes transitively: a module declared from a declared test file is test code", async () => {
    expect(
      await declaredTestFiles({
        "src/lib.rs": "#[cfg(test)]\nmod testutil;\nmod parser;\n",
        "src/testutil.rs": "mod helpers;\n",
        "src/testutil/helpers.rs": "mod deeper;\n",
        "src/testutil/helpers/deeper.rs": "",
        "src/parser.rs": "",
      }),
    ).toEqual(["src/testutil.rs", "src/testutil/helpers.rs", "src/testutil/helpers/deeper.rs"]);
  });

  it("does not include production modules", async () => {
    expect(
      await declaredTestFiles({
        "src/lib.rs": "mod parser;\npub mod lexer;\n",
        "src/parser.rs": '#[cfg(feature = "x")]\nmod extra;\n',
        "src/lexer.rs": "",
        "src/parser/extra.rs": "",
      }),
    ).toEqual([]);
  });

  it("does not include a module compiled outside the test build too: cfg(any(test, x))", async () => {
    expect(
      await declaredTestFiles({
        "src/lib.rs": '#[cfg(any(test, feature = "testing"))]\nmod testutil;\n',
        "src/testutil.rs": "",
      }),
    ).toEqual([]);
  });

  it("includes `cfg(all(test, unix))` and ignores declarations whose file is not in the run", async () => {
    expect(
      await declaredTestFiles({
        "src/lib.rs": "#[cfg(all(test, unix))]\nmod unix_tests;\n#[cfg(test)]\nmod missing;\n",
        "src/unix_tests.rs": "",
      }),
    ).toEqual(["src/unix_tests.rs"]);
  });

  it("takes every module a `#![cfg(test)]` file declares", async () => {
    expect(
      await declaredTestFiles({
        "src/lib.rs": "#[cfg(test)]\nmod harness;\n",
        "src/harness.rs": "#![cfg(test)]\nmod fixtures;\n",
        "src/harness/fixtures.rs": "",
        "src/other.rs": "#![cfg(test)]\nmod nested;\n",
        "src/other/nested.rs": "",
      }),
    ).toEqual(["src/harness.rs", "src/harness/fixtures.rs", "src/other/nested.rs"]);
  });

  it("treats a src/bin file as a crate root and ignores non-Rust files", async () => {
    expect(
      await declaredTestFiles({
        "src/bin/tool.rs": "#[cfg(test)]\nmod checks;\n",
        "src/bin/checks.rs": "",
        "README.md": "#[cfg(test)] mod x;",
      }),
    ).toEqual(["src/bin/checks.rs"]);
  });

  it("treats a Cargo.toml `[lib] path` target as a crate root", async () => {
    expect(
      await declaredTestFiles({
        "crates/core/Cargo.toml": '[package]\nname = "grep-core"\n\n[lib]\npath = "src/core.rs"\n',
        "crates/core/src/core.rs": "#[cfg(test)]\nmod testutil;\n",
        "crates/core/src/testutil.rs": "",
        "crates/core/src/core/testutil.rs": "",
      }),
    ).toEqual(["crates/core/src/testutil.rs"]);
  });

  it("treats every Cargo.toml `[[bin]] path` target as a crate root", async () => {
    expect(
      await declaredTestFiles({
        "Cargo.toml": '[package]\nname = "tool"\n\n[[bin]]\nname = "rg"\npath = "crates/core/flags.rs"\n',
        "crates/core/flags.rs": "#[cfg(test)]\nmod fixtures;\n",
        "crates/core/fixtures.rs": "",
        "crates/core/flags/fixtures.rs": "",
      }),
    ).toEqual(["crates/core/fixtures.rs"]);
  });

  it("survives a cycle of declarations and an unreadable file", async () => {
    expect(
      await declaredTestFiles({
        "src/lib.rs": "#[cfg(test)]\nmod a;\n",
        "src/a.rs": '#[path = "lib.rs"]\nmod back;\n',
      }),
    ).toEqual(["src/a.rs", "src/lib.rs"]);
    const found = await findRustDeclaredTestFiles({
      relativePaths: ["src/lib.rs"],
      readFile: async () => undefined,
    });
    expect([...found]).toEqual([]);
  });
});
