/**
 * Architecture DTO barrel re-export surface pin (bd tea-rags-mcp-89k7k.25).
 *
 * The silent-coupling detector flagged `api/public/dto/index.ts` as
 * co-changing with the boundary-diagnostics vocabulary on every detector
 * landing: the barrel hand-listed every architecture name re-exported from
 * `./architecture.js`, so each new contract shape was written twice — once in
 * the finding contract, once into this hand list. That hand list WAS the
 * mirror the finding contract's own docblock forbids ("a new detector shape
 * is added ONCE here ... instead of hand-syncing").
 *
 * The barrel re-exports `./architecture.js` wholesale; this pin keeps the
 * hand list dead — a new contract shape reaches consumers without an edit
 * here, and the co-change with the vocabulary files disappears with it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../../../..");
const DTO_INDEX = "src/core/api/public/dto/index.ts";

describe("dto barrel re-exports the architecture surface wholesale (bd tea-rags-mcp-89k7k.25)", () => {
  const text = readFileSync(join(ROOT, DTO_INDEX), "utf-8");

  it("re-exports ./architecture.js with a type wildcard", () => {
    expect(text).toMatch(/export\s+type\s+\*\s+from\s+"\.\/architecture\.js"/);
  });

  it("hand-lists no architecture names from ./architecture.js", () => {
    const namedForm = [...text.matchAll(/export\s+type\s+\{([^}]*)\}\s*from\s*"\.\/architecture\.js"/g)].flatMap((m) =>
      (m[1] ?? "")
        .split(",")
        .map((clause) =>
          clause
            .trim()
            .replace(/^\/\/.*$/, "")
            .trim(),
        )
        .filter(Boolean),
    );
    expect(namedForm, "the hand-listed architecture mirror must stay gone").toEqual([]);
  });
});
