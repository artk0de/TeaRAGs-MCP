import { describe, expect, it } from "vitest";

import { formatMcpResponse, formatMcpText, makeStrictJsonSafe } from "../../src/mcp/format.js";

/** Control chars must reach the fixture at runtime, never typed literally (bd k8gac). */
const VT = String.fromCharCode(0x0b); // vertical tab — the class the bead reported
const BS = String.fromCharCode(0x08); // backspace
const RS = String.fromCharCode(0x1f); // unit separator
const CR = String.fromCharCode(0x0d); // carriage return

/** Report-shaped fixture: a violation evidence row carrying an import specifier. */
function reportWithEvidence(importText: string): Record<string, unknown> {
  return {
    violations: [
      {
        kind: "internal-reach",
        source: "src/core/domains/language/shared/ecmascript-symbol-lookup.ts",
        evidence: { importText },
      },
    ],
  };
}

/** strict JSON (the consumers named in the bead: jq, python json.load, JSON.parse). */
function parseStrict(text: string): unknown {
  return JSON.parse(text);
}

/**
 * bd tea-rags-mcp-89k7k.21 — the serialization boundary: nothing that fails a
 * strict JSON parse may leave the formatter, whichever producer built the text.
 */
describe("makeStrictJsonSafe", () => {
  it("should escape a raw control character spliced into an assembled JSON document", () => {
    // The historical mechanism: a producer spliced raw file-derived bytes into
    // hand-assembled JSON text — the raw VT lands inside the evidence string.
    const assembled = JSON.stringify(reportWithEvidence("impMARK"), null, 2).replace("impMARK", `imp${VT}ort`);

    const safe = makeStrictJsonSafe(assembled);
    const parsed = parseStrict(safe) as { violations: [{ evidence: { importText: string } }] };
    expect(parsed.violations[0]?.evidence.importText).toBe(`imp${VT}ort`);
  });

  it("should round-trip the full C0 control class inside string literals", () => {
    const chars = Array.from({ length: 0x20 }, (_, code) => String.fromCharCode(code)).join("");
    const safe = makeStrictJsonSafe(JSON.stringify({ evidence: chars }));

    const parsed = parseStrict(safe) as { evidence: string };
    expect(parsed.evidence).toBe(chars);
  });

  it("should leave clean pretty-printed JSON byte-identical", () => {
    const clean = JSON.stringify(reportWithEvidence("import { X } from './x.js'"), null, 2);
    expect(makeStrictJsonSafe(clean)).toBe(clean);
  });

  it("should leave already-escaped unicode sequences untouched", () => {
    // `\u000b` as six literal characters — what JSON.stringify emits.
    const preEscaped = '{"evidence":"imp\\u000bort"}';
    expect(makeStrictJsonSafe(preEscaped)).toBe(preEscaped);
  });

  it("should not touch control characters outside string literals", () => {
    // A document whose only control chars are pretty-print whitespace.
    const doc = '{\n  "a": [\n    1,\n    2\n  ]\n}\r\n';
    expect(makeStrictJsonSafe(doc)).toBe(doc);
  });

  it("should return plain text without quotes or control chars unchanged", () => {
    expect(makeStrictJsonSafe("Error: project not found")).toBe("Error: project not found");
  });
});

describe("formatMcpText — strict-JSON-safe boundary", () => {
  it("should emit text that strict-parses when assembled content carries a raw control char", () => {
    const assembled = JSON.stringify(reportWithEvidence("impMARK"), null, 2).replace("impMARK", `imp${VT}ort`);

    const result = formatMcpText(assembled);
    const parsed = parseStrict(result.content[0]?.text ?? "") as {
      violations: [{ evidence: { importText: string } }];
    };
    expect(parsed.violations[0]?.evidence.importText).toBe(`imp${VT}ort`);
  });
});

describe("formatMcpResponse — strict-JSON-safe boundary", () => {
  it("should emit output that strict-parses when an evidence field carries raw control chars", () => {
    const data = reportWithEvidence(`a${BS}b${VT}c${RS}d${CR}e`);

    const result = formatMcpResponse(data);
    const parsed = parseStrict(result.content[0]?.text ?? "") as {
      violations: [{ evidence: { importText: string } }];
    };
    expect(parsed.violations[0]?.evidence.importText).toBe(`a${BS}b${VT}c${RS}d${CR}e`);
  });

  it("should keep clean data byte-identical to plain stringify output", () => {
    const data = reportWithEvidence("import { X } from './x.js'");
    expect(formatMcpResponse(data).content[0]?.text).toBe(JSON.stringify(data, null, 2));
  });
});
