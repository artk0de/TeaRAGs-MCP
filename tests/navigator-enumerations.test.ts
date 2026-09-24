/**
 * Domain navigators name CONTRACTS; a set of implementers is pinned HERE
 * (bd tea-rags-mcp-fk920).
 *
 * `navigator-code-references.test.ts` constrains the FORM of a citation — a
 * symbol, never `file.ts:NNN`. It cannot constrain the TRUTH of a claim, and
 * the claims that rot fastest are enumerations: "TypeScript and JavaScript
 * answer `hasInProjectDefinition`" was written when that was the whole set,
 * stayed in `domains/language/CLAUDE.md` after the Swift vertical landed, and
 * an agent repeated it to the user as current fact. A set changes whenever a
 * language is added, which is routine here.
 *
 * So the navigator states the contract and points at this file, and the set
 * lives in ONE place a test derives. Prose cannot contradict the code because
 * prose no longer states the set.
 *
 * Derivation is from the FACADE (`<lang>/index.ts`'s `LanguageProvider.resolver`),
 * never from the `CallResolver` behind it: the resolution runner reads the
 * facade, so a method the resolver has and the facade does not forward is
 * invisible in production while a unit test driving the bare resolver passes
 * (bd tea-rags-mcp-x9qsh).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { LanguageSymbolResolver } from "../src/core/contracts/types/language.js";
import { LanguageFactory } from "../src/core/domains/language/factory.js";
import { navigators, REPO_ROOT } from "./navigator-files.js";

/** This file, as a navigator must cite it. */
const PIN_TEST = "navigator-enumerations.test.ts";

/**
 * Which language FACADES forward each optional `LanguageSymbolResolver`
 * capability. A language absent from a set takes the runner's default for that
 * capability — which is a behavioural difference, not an omission.
 */
const PINNED_CAPABILITY_LANGUAGES: Readonly<Record<string, readonly string[]>> = {
  diagnostics: ["typescript"],
  hasInProjectDefinition: ["javascript", "python", "ruby", "swift", "typescript"],
  prepareResolvePass: ["go", "typescript"],
  resolveFileEdges: ["javascript", "python", "ruby", "typescript"],
  targetsCoreAmbiguousMember: ["python", "ruby"],
  targetsExternalImport: ["javascript", "python", "ruby", "typescript"],
};

/**
 * Resolver strategies that PARK a candidate for a later pass (`deferred(...)`).
 * Deferral pays only where a later pass holds evidence the parking pass lacks,
 * so this set grows by measurement, never by symmetry.
 */
const PINNED_PARK_SITES: readonly string[] = [
  "ruby/ruby-constant",
  "ruby/ruby-explicit-require",
  "typescript/ts-import-basename",
  "typescript/ts-named-import",
  "typescript/ts-receiver-symbol",
];

/**
 * How each supported language is NAMED in navigator prose. Asserted complete
 * against the factory below, so a new language cannot slip past the guard by
 * having no spelling here.
 */
const LANGUAGE_SPELLINGS: Readonly<Record<string, RegExp>> = {
  bash: /\bBash\b/,
  go: /\bGo\b/,
  java: /\bJava\b/,
  javascript: /\bJavaScript\b|\bJS\b/,
  markdown: /\bMarkdown\b/,
  python: /\bPython\b/,
  ruby: /\bRuby\b/,
  rust: /\bRust\b/,
  swift: /\bSwift\b/,
  typescript: /\bTypeScript\b|\bTS\b/,
};

/** Every pinned set, and how navigator prose refers to it. */
const PINNED_SETS: readonly { readonly name: string; readonly mention: RegExp }[] = [
  ...Object.keys(PINNED_CAPABILITY_LANGUAGES).map((capability) => ({
    name: capability,
    // The capability itself: `diagnostics` in backticks, not "diagnostics" the
    // word, and not some other type's same-named method — the runner's own
    // `CallEdgeResolutionRunner#prepareResolvePass` calls the capability, it is
    // not one of its implementers.
    mention: new RegExp(String.raw`\x60(?:(?:LanguageSymbolResolver|CallResolver)[.#])?${capability}\x60`),
  })),
  { name: "park sites", mention: /\bpark sites?\b/i },
];

/** The optional members `LanguageSymbolResolver` declares, read off the contract. */
function declaredOptionalCapabilities(): string[] {
  const contract = readFileSync(join(REPO_ROOT, "src/core/contracts/types/language.ts"), "utf8");
  const body = /export interface LanguageSymbolResolver \{\n([\s\S]*?)\n\}/.exec(contract)?.[1];
  if (body === undefined) throw new Error("LanguageSymbolResolver interface not found in contracts/types/language.ts");
  return [...body.matchAll(/^ {2}(\w+)\?:/gm)].map((match) => match[1]).sort();
}

/** Languages whose FACADE exposes `capability`, in the order the factory reports. */
function languagesForwarding(capability: keyof LanguageSymbolResolver): string[] {
  const factory = new LanguageFactory();
  return factory
    .supported()
    .filter((language) => typeof factory.create(language).resolver?.[capability] === "function")
    .sort();
}

/** `<language>/<strategy>` for every resolver strategy that calls `deferred(`. */
function parkSites(): string[] {
  const root = join(REPO_ROOT, "src/core/domains/language");
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .map((entry) => entry.split(/[\\/]/).join("/"))
    .filter((entry) => /^[^/]+\/resolver\/strategies\/[^/]+\.ts$/.test(entry))
    .filter((entry) => /\bdeferred\s*\(/.test(stripComments(readFileSync(join(root, entry), "utf8"))))
    .map((entry) => entry.replace(/\/resolver\/strategies\//, "/").replace(/\.ts$/, ""))
    .sort();
}

/** Source with comments blanked, so a docblock naming a helper is not a call to it. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Navigator prose split on top-level list items — the unit an invariant is
 * written in. Everything before the first item is one leading block.
 */
function bullets(markdown: string): string[] {
  const blocks: string[][] = [[]];
  for (const line of markdown.split("\n")) {
    if (line.startsWith("- ")) blocks.push([]);
    blocks.at(-1)?.push(line);
  }
  return blocks.filter((block) => block.length > 0).map((block) => block.join("\n"));
}

interface EnumerationOffense {
  /** 1-based line of the bullet inside the navigator. */
  line: number;
  set: string;
  languages: string[];
}

/**
 * Bullets that name a pinned set AND name two or more languages, without citing
 * the file that derives the set. One language is a worked example; two is an
 * enumeration, and an enumeration kept by hand is the thing that drifts.
 */
function enumerationOffenses(markdown: string): EnumerationOffense[] {
  let line = 1;
  return bullets(markdown).flatMap((block) => {
    const at = line;
    line += block.split("\n").length;
    if (block.includes(PIN_TEST)) return [];
    return PINNED_SETS.filter((set) => set.mention.test(block)).flatMap((set) => {
      const languages = Object.entries(LANGUAGE_SPELLINGS)
        .filter(([, spelling]) => spelling.test(block))
        .map(([language]) => language);
      return languages.length < 2 ? [] : [{ line: at, set: set.name, languages }];
    });
  });
}

describe("LanguageSymbolResolver capability sets", () => {
  it("pins every optional capability the contract declares", () => {
    expect(declaredOptionalCapabilities()).toEqual(Object.keys(PINNED_CAPABILITY_LANGUAGES).sort());
  });

  it("spells every supported language the guard must recognise", () => {
    expect(new Set(new LanguageFactory().supported())).toEqual(new Set(Object.keys(LANGUAGE_SPELLINGS)));
  });

  it.each(Object.entries(PINNED_CAPABILITY_LANGUAGES))(
    "%s is forwarded by exactly the pinned facades",
    (capability, expected) => {
      expect(languagesForwarding(capability as keyof LanguageSymbolResolver)).toEqual([...expected]);
    },
  );
});

describe("resolver deferral", () => {
  it("parks a candidate at exactly the pinned strategies", () => {
    expect(parkSites()).toEqual([...PINNED_PARK_SITES]);
  });
});

describe("domain navigators", () => {
  it("name the contract instead of enumerating its implementers", () => {
    const offenses = navigators().flatMap((path) =>
      enumerationOffenses(readFileSync(join(REPO_ROOT, path), "utf8")).map(
        (offense) => `${path} bullet at line ${offense.line} → ${offense.set} over ${offense.languages.join(", ")}`,
      ),
    );
    // Joined, not compared as an array: the failure IS the list of places to fix.
    expect(
      offenses.join("\n"),
      `${offenses.length} hand-kept enumeration(s); name the contract and cite ${PIN_TEST}, which derives the set`,
    ).toBe("");
  });
});
