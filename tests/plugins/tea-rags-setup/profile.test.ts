import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  CODE_LANGUAGES,
  LANGUAGE_MAP,
} from "../../../src/core/domains/ingest/pipeline/chunker/language-config/config.js";
import { makeRepo, runScript, SCRIPTS_DIR } from "./fixtures.js";

const lines = (n: number): string => `${Array.from({ length: n }, (_, i) => `line ${i}`).join("\n")}\n`;

describe("profile.mjs", () => {
  it("reports a missing CLI argument through the script entrypoint", async () => {
    const originalArgv = process.argv;
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      process.argv = [process.execPath, join(SCRIPTS_DIR, "profile.mjs")];
      vi.resetModules();
      await import(join(SCRIPTS_DIR, "profile.mjs"));
      expect(JSON.parse(String(stdout.mock.calls[0][0]))).toEqual({
        error: "projectDir not found: (missing argument)",
      });
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      process.argv = originalArgv;
      stdout.mockRestore();
      exit.mockRestore();
      vi.resetModules();
    }
  });
  it("excludes ignore-file matches and reports the Ruby share", () => {
    const dir = makeRepo({
      "app/a.rb": lines(30),
      "app/b.rb": lines(30),
      "web/x.js": lines(20),
      "target/debug/gen.rs": lines(500),
      ".svelte-kit/out.js": lines(500),
      "ignored/z.py": lines(400),
      "README.md": lines(50),
    });
    writeFileSync(join(dir, ".gitignore"), "ignored/\n");
    writeFileSync(join(dir, ".contextignore.local"), "target/\n.svelte-kit/\n");
    const { status, json } = runScript("profile.mjs", [dir]);
    expect(status).toBe(0);
    const languages = json.languages as Record<string, { files: number; loc: number; share: number }>;
    expect(languages.ruby).toEqual({ files: 2, loc: 60, share: 0.75 });
    expect(languages.javascript).toEqual({ files: 1, loc: 20, share: 0.25 });
    expect(languages.rust).toBeUndefined();
    expect(languages.python).toBeUndefined();
    expect(json.files).toBe(3);
    expect(json.loc).toBe(80);
    expect(json.estimatedChunks).toBeGreaterThan(0);
  });

  it("honours .contextignore as well as .contextignore.local", () => {
    const dir = makeRepo({ "a.rb": lines(10), "gen/b.rb": lines(10) });
    writeFileSync(join(dir, ".contextignore"), "gen/\n");
    const { json } = runScript("profile.mjs", [dir]);
    expect(json.files).toBe(1);
  });

  it("emits a JSON error and exits 1 for a missing directory", () => {
    const { status, json } = runScript("profile.mjs", [join(makeRepo({ a: "x" }), "missing")]);
    expect(status).toBe(1);
    expect(typeof json.error).toBe("string");
  });

  it("keeps the inlined extension table in sync with the indexer's language mapping", async () => {
    const mod = (await import(join(SCRIPTS_DIR, "profile.mjs"))) as { EXTENSION_LANGUAGES: Record<string, string> };
    const expected = Object.fromEntries(Object.entries(LANGUAGE_MAP).filter(([, lang]) => CODE_LANGUAGES.has(lang)));
    expect(mod.EXTENSION_LANGUAGES).toEqual(expected);
  });

  it("profiles the added languages through the script entrypoint and skips missing tracked files", async () => {
    const dir = makeRepo({
      "app.php": "<?php\necho 'ok';",
      "Main.kt": "fun main() {}\n",
      "build.kts": "println(1)\n",
      "main.m": "void greet(void) {}\n",
      "native.mm": "void greet(void) {}\n",
      "empty.rb": "",
      "deleted.ts": lines(10),
      "ignored.py": lines(20),
      "README.md": lines(50),
    });
    rmSync(join(dir, "deleted.ts"));
    writeFileSync(join(dir, ".contextignore"), "ignored.py\n");
    const originalArgv = process.argv;
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      process.argv = [process.execPath, join(SCRIPTS_DIR, "profile.mjs"), dir];
      vi.resetModules();
      await import(join(SCRIPTS_DIR, "profile.mjs"));
      expect(stdout).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(stdout.mock.calls[0][0]))).toEqual({
        files: 6,
        loc: 6,
        estimatedChunks: 6,
        languages: {
          php: { files: 1, loc: 2, share: 0.33 },
          kotlin: { files: 2, loc: 2, share: 0.33 },
          objc: { files: 2, loc: 2, share: 0.33 },
          ruby: { files: 1, loc: 0, share: 0 },
        },
      });
    } finally {
      process.argv = originalArgv;
      stdout.mockRestore();
      vi.resetModules();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
