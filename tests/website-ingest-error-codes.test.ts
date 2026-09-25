/**
 * The website's Error Codes Reference covers every IngestErrorCode (bd tea-rags-mcp-5wrou).
 *
 * `website/docs/operations/troubleshooting-and-error-codes.md` carries one table
 * row per structured error code. It drifted: eight `IngestErrorCode` values were
 * added to the union without a row, so an operator who met one in an MCP
 * response found nothing on the page. This test derives the code set from the
 * union itself and requires the table to name exactly that set — a new code
 * without a row fails, and so does a row for a code the union dropped.
 *
 * The union is a type, not a runtime value, so it is read from the declaring
 * source file rather than imported.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const ERRORS_SOURCE = "src/core/domains/ingest/errors.ts";
const PAGE = "website/docs/operations/troubleshooting-and-error-codes.md";
const TABLE_HEADING = "## Error Codes Reference";

/** Every string literal member of `export type IngestErrorCode = | "…" | …;`. */
function ingestErrorCodesFromUnion(): string[] {
  const source = readFileSync(join(ROOT, ERRORS_SOURCE), "utf8");
  const declaration = /export type IngestErrorCode =([^;]+);/.exec(source);
  if (!declaration) throw new Error(`IngestErrorCode union not found in ${ERRORS_SOURCE}`);
  return [...declaration[1].matchAll(/"([A-Z0-9_]+)"/g)].map((match) => match[1]).sort();
}

/** The `INGEST_*` codes named in the first cell of the Error Codes Reference table rows. */
function ingestCodesInReferenceTable(): string[] {
  const page = readFileSync(join(ROOT, PAGE), "utf8");
  const start = page.indexOf(TABLE_HEADING);
  if (start === -1) throw new Error(`"${TABLE_HEADING}" not found in ${PAGE}`);
  const nextSection = page.indexOf("\n## ", start + TABLE_HEADING.length);
  const section = page.slice(start, nextSection === -1 ? undefined : nextSection);
  return section
    .split("\n")
    .map((line) => /^\|\s*`(INGEST_[A-Z0-9_]+)`\s*\|/.exec(line)?.[1])
    .filter((code): code is string => code !== undefined)
    .sort();
}

describe("website error-code reference matches the IngestErrorCode union", () => {
  it("names every IngestErrorCode exactly once, and no code outside the union", () => {
    const union = ingestErrorCodesFromUnion();
    // Guard against a silently-empty parse: the union has many members.
    expect(union.length).toBeGreaterThan(10);
    const table = ingestCodesInReferenceTable();
    expect(
      union.filter((code) => !table.includes(code)),
      "IngestErrorCode values missing from the reference table",
    ).toEqual([]);
    expect(
      table.filter((code) => !union.includes(code)),
      "reference table rows for codes not in the IngestErrorCode union",
    ).toEqual([]);
    expect(table, "duplicate rows in the reference table").toEqual([...new Set(table)]);
  });
});
