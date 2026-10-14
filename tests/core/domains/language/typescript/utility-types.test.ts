import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { TS_UTILITY_TYPES } from "../../../../../src/core/domains/language/typescript/utility-types.js";

/**
 * The utility-type vocabulary is the default lib's, not a curated list (bd
 * tea-rags-mcp-mqaj7): every GENERIC type alias `lib.es5.d.ts` declares at the
 * top level, read from the compiler this repository installs.
 */
describe("TS_UTILITY_TYPES", () => {
  it("is exactly the generic type aliases the installed default lib declares", () => {
    const typescriptLib = dirname(createRequire(import.meta.url).resolve("typescript"));
    const es5 = readFileSync(join(typescriptLib, "lib.es5.d.ts"), "utf8");
    const declared = [...es5.matchAll(/^type ([A-Za-z]+)</gm)].map(([, name]) => name);

    expect([...TS_UTILITY_TYPES].sort()).toEqual(declared.sort());
  });
});
