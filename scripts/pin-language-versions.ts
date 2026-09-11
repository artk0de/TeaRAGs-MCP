import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { computeVersionPins } from "../src/core/domains/language/capability/version-pins.js";
import { LanguageFactory } from "../src/core/domains/language/factory.js";
import { SHARED_LANGUAGE } from "../src/core/domains/language/kernel/capability.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = resolve(root, "tests/core/domains/language/capability/version-pins.json");
const pins = computeVersionPins(new LanguageFactory().capabilities(), root);
writeFileSync(target, `${JSON.stringify(pins, null, 2)}\n`, "utf8");

// `*` is not a language and counting it as one misreports how many verticals
// were pinned — it is one more row standing for the sources they all share.
const languages = Object.keys(pins).filter((key) => key !== SHARED_LANGUAGE).length;
const shared = pins[SHARED_LANGUAGE] ? ` + the shared \`${SHARED_LANGUAGE}\` axes` : "";
console.log(`✓ ${target} re-pinned for ${languages} languages${shared}.`);
