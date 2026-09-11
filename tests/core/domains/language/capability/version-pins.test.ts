import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { versionAxisSources } from "../../../../../src/core/domains/language/capability/version-axes.js";
import { digestSources, type VersionPins } from "../../../../../src/core/domains/language/capability/version-pins.js";
import { LanguageFactory } from "../../../../../src/core/domains/language/factory.js";

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

  for (const [language, cap] of caps) {
    for (const { axis, paths } of versionAxisSources(language)) {
      const digest = digestSources(paths);
      if (digest === null) continue; // language has no sources on this axis

      it(`${language}.${axis} sources are pinned to version ${cap.versions[axis]}`, () => {
        const pin = pins[language]?.[axis];
        expect(pin, `no pin for ${language}.${axis} — run: npm run pin:lang-versions`).toBeDefined();
        expect(pin?.version, `${language}.${axis} declared version moved — run: npm run pin:lang-versions`).toBe(
          cap.versions[axis],
        );
        expect(
          pin?.digest,
          `${paths.join(", ")} changed since ${language}.${axis} v${cap.versions[axis]} was pinned. ` +
            `Bump versions.${axis} in ${language}/capability.ts if the output changed, then run: npm run pin:lang-versions. ` +
            `Re-pinning without a bump is a byte-identical claim — add "Versions: unchanged — <why>" to the commit body.`,
        ).toBe(digest);
      });
    }
  }
});
