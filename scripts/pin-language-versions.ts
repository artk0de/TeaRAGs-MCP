import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { computeVersionPins } from "../src/core/domains/language/capability/version-pins.js";
import { LanguageFactory } from "../src/core/domains/language/factory.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = resolve(root, "tests/core/domains/language/capability/version-pins.json");
const pins = computeVersionPins(new LanguageFactory().capabilities(), root);
writeFileSync(target, `${JSON.stringify(pins, null, 2)}\n`, "utf8");
console.log(`✓ ${target} re-pinned for ${Object.keys(pins).length} languages.`);
