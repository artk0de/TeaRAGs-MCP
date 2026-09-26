/**
 * Every language capability declares which declaration kinds can be a call's
 * CALLEE and which its RECEIVER (bd tea-rags-mcp-jqvbn, spec §1a table).
 *
 * The answer is the language's, not the kind vocabulary's: Ruby never calls a
 * class by its bare name, Go calls interfaces and type aliases (a conversion),
 * Swift and Python call enums. `function` and `method` play both parts wherever
 * the language has them. A callee kind need not be a receiver kind: a Python
 * `NewType` is called (`UserId(5)`) and has no members to call.
 *
 * One deviation from the spec table, measured: a Rust `enum` is a receiver
 * only. `Style(x)` is no Rust expression — a call spelled with an enum's name
 * builds a VARIANT (`SpecValue::Style(style)`), and counting the enum as a
 * callee re-landed that call on the unrelated `enum Style` (ripgrep).
 */
import { describe, expect, it } from "vitest";

import type { SymbolDefinitionKind } from "../../../../../src/core/contracts/types/codegraph.js";
import { nativeLanguageCapabilities } from "../../../../../src/core/domains/language/capability/native.js";

type Row = { callee: SymbolDefinitionKind[]; receiver: SymbolDefinitionKind[] };

const FN: SymbolDefinitionKind[] = ["function", "method"];

const ECMASCRIPT: Row = {
  callee: ["class", ...FN],
  receiver: ["class", "module", "enum", "constant", ...FN],
};

const EXPECTED: Record<string, Row> = {
  typescript: ECMASCRIPT,
  javascript: ECMASCRIPT,
  java: {
    callee: ["class", ...FN],
    receiver: ["class", "interface", "enum", "constant", ...FN],
  },
  swift: {
    callee: ["class", "enum", "type_alias", ...FN],
    receiver: ["class", "interface", "enum", "type_alias", "constant", ...FN],
  },
  go: {
    callee: ["class", "interface", "type_alias", ...FN],
    receiver: ["class", "module", "interface", "type_alias", "constant", ...FN],
  },
  rust: {
    callee: ["class", ...FN],
    receiver: ["class", "module", "interface", "enum", "constant", ...FN],
  },
  python: {
    callee: ["class", "enum", "type_alias", ...FN],
    receiver: ["class", "module", "enum", "constant", ...FN],
  },
  ruby: {
    callee: FN,
    receiver: ["class", "module", "constant", ...FN],
  },
  bash: { callee: ["function"], receiver: ["function"] },
  markdown: { callee: [], receiver: [] },
};

const sorted = (kinds: Iterable<SymbolDefinitionKind>): SymbolDefinitionKind[] => [...kinds].sort();

describe("LanguageCapability.codegraph.symbolKindRoles (bd tea-rags-mcp-jqvbn)", () => {
  it("covers every native language", () => {
    expect([...nativeLanguageCapabilities().keys()].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(Object.entries(EXPECTED))("%s declares its callee and receiver kinds", (language, row) => {
    const roles = nativeLanguageCapabilities().get(language)?.codegraph.symbolKindRoles;
    expect(roles).toBeDefined();
    expect(sorted(roles?.callee ?? [])).toEqual(sorted(row.callee));
    expect(sorted(roles?.receiver ?? [])).toEqual(sorted(row.receiver));
  });
});
