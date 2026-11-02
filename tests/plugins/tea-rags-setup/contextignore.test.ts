import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { makeRepo, runScript } from "./fixtures.js";

const read = (dir: string): string => readFileSync(join(dir, ".contextignore.local"), "utf8");

describe("contextignore.mjs", () => {
  it("adds target/ for a Rust repo, including a nested backend/Cargo.toml", () => {
    const dir = makeRepo({ "backend/Cargo.toml": "[package]\n", "backend/src/main.rs": "fn main(){}\n" });
    const { status, json } = runScript("contextignore.mjs", [dir]);
    expect(status).toBe(0);
    expect(json.added).toContain("target/");
    expect(read(dir)).toContain("# tea-rags install");
    expect(read(dir)).toContain("target/");
    expect(read(dir)).not.toContain("node_modules/");
  });

  it("adds .svelte-kit/ for a SvelteKit repo and keeps pre-existing user lines in place", () => {
    const dir = makeRepo({ "package.json": "{}\n", "svelte.config.js": "export default {};\n" });
    writeFileSync(join(dir, ".contextignore.local"), "my-secret-dir/\n# mine\n");
    const { json } = runScript("contextignore.mjs", [dir]);
    expect(json.added).toContain(".svelte-kit/");
    expect(json.kept).toBe(2);
    expect(read(dir).startsWith("my-secret-dir/\n# mine\n")).toBe(true);
  });

  it("is idempotent: a second run adds nothing", () => {
    const dir = makeRepo({ Gemfile: "source 'x'\n", "app.rb": "puts 1\n" });
    const first = runScript("contextignore.mjs", [dir]).json;
    const before = read(dir);
    const second = runScript("contextignore.mjs", [dir]).json;
    expect((first.added as string[]).length).toBeGreaterThan(0);
    expect(first.added).toContain("vendor/bundle/");
    expect(second.added).toEqual([]);
    expect(read(dir)).toBe(before);
  });

  it("adds the all-stack generated-file patterns", () => {
    const dir = makeRepo({ "go.mod": "module x\n" });
    const { json } = runScript("contextignore.mjs", [dir]);
    for (const pattern of ["*.min.js", "*.map", "*.lock", "package-lock.json", "*.pb.go", "*_pb2.py", "vendor/"]) {
      expect(json.added).toContain(pattern);
    }
  });

  it("does not duplicate a pattern the user already wrote", () => {
    const dir = makeRepo({ "Cargo.toml": "[package]\n" });
    writeFileSync(join(dir, ".contextignore.local"), "target/\n");
    const { json } = runScript("contextignore.mjs", [dir]);
    expect(json.added).not.toContain("target/");
  });

  it("emits a JSON error and exits 1 for a missing directory", () => {
    const { status, json } = runScript("contextignore.mjs", [join(makeRepo({ a: "x" }), "nope")]);
    expect(status).toBe(1);
    expect(typeof json.error).toBe("string");
  });
});
