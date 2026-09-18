import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { computeVersionPins } from "../src/core/domains/language/capability/version-pins.js";
import { LanguageFactory } from "../src/core/domains/language/factory.js";
import { SHARED_LANGUAGE } from "../src/core/domains/language/kernel/capability.js";
import { formatPendingSourcesAsLintStagedWould } from "./lib/lint-staged-format.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = resolve(root, "tests/core/domains/language/capability/version-pins.json");

// Format first, digest second: lint-staged rewrites these bytes at commit time,
// and a pin computed over the pre-hook bytes fails its own test (bd e6xx).
const formatted = formatPendingSourcesAsLintStagedWould(root);
if (formatted.failures.length > 0) {
  console.warn(
    `! lint-staged commands failed (${formatted.failures.join("; ")}) — the commit will fail on them too; ` +
      "pinning what the fixers did write.",
  );
}

const pins = computeVersionPins(new LanguageFactory().capabilities(), root);
writeFileSync(target, `${JSON.stringify(pins, null, 2)}\n`, "utf8");

// `*` is not a language and counting it as one misreports how many verticals
// were pinned — it is one more row standing for the sources they all share.
const languages = Object.keys(pins).filter((key) => key !== SHARED_LANGUAGE).length;
const shared = pins[SHARED_LANGUAGE] ? ` + the shared \`${SHARED_LANGUAGE}\` axes` : "";
console.log(`✓ ${target} re-pinned for ${languages} languages${shared}.`);
