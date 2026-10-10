import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { extractFile, readCorpusDeclaredDependencies } from "../../scripts/ts-codegraph-typechecker-oracle.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../src/core/domains/language/index.js";

const ABILITY = `class Ability
  def initialize(user)
    can :read, Post
  end
end
`;

/** bd tea-rags-mcp-0qaht.48: the harness walks Ruby with the run's Gemfile gate, like production. */
describe("extractFile Ruby DSL gate", () => {
  let root: string;
  const factory = new LanguageFactory({ repoRoot: tmpdir() });
  const composer = new DefaultSymbolIdComposer();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "extract-file-gate-"));
    mkdirSync(join(root, "app"), { recursive: true });
    writeFileSync(join(root, "app", "ability.rb"), ABILITY);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const subjectRefCalls = (gemfile: string): string[] => {
    writeFileSync(join(root, "Gemfile"), gemfile);
    const declared = readCorpusDeclaredDependencies(root, factory);
    const extraction = extractFile(root, "app/ability.rb", composer, factory, declared);
    return (extraction?.chunks ?? []).flatMap((chunk) =>
      chunk.calls.filter((call) => call.member === "Post").map((call) => call.callText),
    );
  };

  it("emits the cancancan rule-subject fact only when the Gemfile declares the gem", () => {
    const without = subjectRefCalls("source 'https://rubygems.org'\ngem 'rails'\n");
    const withGem = subjectRefCalls("source 'https://rubygems.org'\ngem 'rails'\ngem 'cancancan'\n");
    expect(without).toEqual([]);
    expect(withGem).not.toEqual([]);
  });
});
