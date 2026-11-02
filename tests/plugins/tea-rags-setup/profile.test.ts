import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CODE_LANGUAGES,
  LANGUAGE_MAP,
} from "../../../src/core/domains/ingest/pipeline/chunker/language-config/config.js";
import { makeRepo, runScript, SCRIPTS_DIR } from "./fixtures.js";

const lines = (n: number): string => `${Array.from({ length: n }, (_, i) => `line ${i}`).join("\n")}\n`;

describe("profile.mjs", () => {
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
});
