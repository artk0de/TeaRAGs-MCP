import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { LanguageCapability, LanguageSupportVersions } from "../../../../../src/core/contracts/types/language.js";
import { versionAxisSources } from "../../../../../src/core/domains/language/capability/version-axes.js";
import {
  computeVersionPins,
  digestSources,
  type VersionPins,
} from "../../../../../src/core/domains/language/capability/version-pins.js";
import { LanguageFactory } from "../../../../../src/core/domains/language/factory.js";
import { SHARED_LANGUAGE, sharedVersions } from "../../../../../src/core/domains/language/kernel/capability.js";

const PINS_PATH = "tests/core/domains/language/capability/version-pins.json";

/**
 * A version number is a claim that the sources behind an axis produce what the
 * index stored. This pins the sources' digest to the declared version: change
 * the sources and either bump the version (output moved) or re-pin without a
 * bump (byte-identical claim, recorded in git). `npm run pin:lang-versions`
 * regenerates the pin file.
 */
describe("language version pins", () => {
  const caps = new LanguageFactory().capabilities();
  const pins = JSON.parse(readFileSync(PINS_PATH, "utf8")) as VersionPins;
  // `*` has no capability descriptor — the sources it stands for belong to no
  // language, so its numbers live in `kernel/capability.ts` instead.
  const declaredVersions = (language: string): LanguageSupportVersions =>
    language === SHARED_LANGUAGE ? sharedVersions : (caps.get(language) as LanguageCapability).versions;
  const pinnedLanguages = [...caps.keys(), SHARED_LANGUAGE];
  const live = new Set<string>();

  for (const language of pinnedLanguages) {
    const descriptor = language === SHARED_LANGUAGE ? "kernel/capability.ts" : `${language}/capability.ts`;

    for (const source of versionAxisSources(language)) {
      const { axis, paths } = source;
      const digest = digestSources(source);
      if (digest === null) continue; // language has no sources on this axis
      live.add(`${language}.${axis}`);

      it(`${language}.${axis} sources are pinned to version ${declaredVersions(language)[axis]}`, () => {
        const declared = declaredVersions(language)[axis];
        const pin = pins[language]?.[axis];
        expect(pin, `no pin for ${language}.${axis} — run: npm run pin:lang-versions`).toBeDefined();
        expect(pin?.version, `${language}.${axis} declared version moved — run: npm run pin:lang-versions`).toBe(
          declared,
        );
        expect(
          pin?.digest,
          `${paths.join(", ")} changed since ${language}.${axis} v${declared} was pinned. ` +
            `Bump versions.${axis} in ${descriptor} if the output changed, then run: npm run pin:lang-versions. ` +
            `Re-pinning without a bump is a byte-identical claim — add "Versions: unchanged — <why>" to the commit body.`,
        ).toBe(digest);
      });
    }
  }

  // The loop above can only catch pins that are WRONG, never pins that should
  // no longer exist: rename `ruby/walker/` or drop a language and its entry
  // sits in the JSON forever, vouching for sources nobody digests any more.
  it("carries no pin for a (language, axis) pair the build no longer has sources for", () => {
    const orphans = Object.entries(pins).flatMap(([language, axes]) =>
      Object.keys(axes)
        .map((axis) => `${language}.${axis}`)
        .filter((key) => !live.has(key)),
    );

    expect(orphans, `orphan pins in ${PINS_PATH} — run: npm run pin:lang-versions`).toEqual([]);
  });
});

/**
 * `computeVersionPins` is what `npm run pin:lang-versions` runs, so the pin file
 * above can only ever be as trustworthy as this function. Exercised on a temp
 * tree rather than the repo: the assertion is that a digest MOVES on a one-byte
 * edit and is otherwise stable, which cannot be stated against sources that are
 * fixed for the duration of the run.
 */
describe("computeVersionPins", () => {
  const root = mkdtempSync(join(tmpdir(), "tea-rags-pins-"));
  const walkerFile = join(root, "src/core/domains/language/faux/kernel.ts");
  const capabilityFile = join(root, "src/core/domains/language/faux/capability.ts");
  const caps = new Map<string, LanguageCapability>([
    [
      "faux",
      {
        language: "faux",
        ast: { tier: "none", engine: "none" },
        tests: { tier: "na", detection: "-", tech: "-" },
        codegraph: { tier: "none", tech: "-" },
        versions: { chunking: 1, walker: 7, codegraphSchema: 1 },
      },
    ],
  ]);

  function write(file: string, contents: string): void {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents, "utf8");
  }

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("pins the declared version against a digest of the axis sources", () => {
    write(walkerFile, "export const walk = () => 1;\n");
    write(capabilityFile, "export const capability = {};\n");

    const pin = computeVersionPins(caps, root).faux?.walker;

    expect(pin?.version).toBe(7);
    expect(pin?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("computes the same digest twice for unchanged sources", () => {
    write(walkerFile, "export const walk = () => 1;\n");

    expect(computeVersionPins(caps, root).faux?.walker?.digest).toBe(
      computeVersionPins(caps, root).faux?.walker?.digest,
    );
  });

  it("moves the digest when a single byte of a source changes", () => {
    write(walkerFile, "export const walk = () => 1;\n");
    const before = computeVersionPins(caps, root).faux?.walker?.digest;

    write(walkerFile, "export const walk = () => 2;\n");

    expect(computeVersionPins(caps, root).faux?.walker?.digest).not.toBe(before);
  });

  it("leaves the digest alone when only an excluded source changes", () => {
    write(walkerFile, "export const walk = () => 1;\n");
    const before = computeVersionPins(caps, root).faux?.walker?.digest;

    write(capabilityFile, "export const capability = { tier: 'none' };\n");

    expect(computeVersionPins(caps, root).faux?.walker?.digest).toBe(before);
  });

  it("omits an axis whose sources do not exist", () => {
    write(walkerFile, "export const walk = () => 1;\n");

    expect(computeVersionPins(caps, root).faux?.chunking).toBeUndefined();
  });
});
