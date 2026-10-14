/**
 * Whether a missing test partner is covered by a test the change DOES touch
 * (bd tea-rags-mcp-89k7k.34). History pairs a source with ONE test file; a
 * change that tests the source in another file is still carrying the pair.
 *
 * Reach is not subject: a test of component B that calls A as a sub-step does
 * not replace a detailed test of A, so an import alone never covers. A touched
 * test covers source S when BOTH hold, read from the working tree (the files
 * the diff touches, re-chunked as find_symbol's `chunks` floor reads them):
 *
 * - its SUBJECT is S — the leading identifier token of a top-level test scope
 *   (`describe("NamingLexiconOps — diff mode")` → `NamingLexiconOps`, RSpec
 *   `describe Billing::Invoice` → `Billing::Invoice`) equals a symbol S
 *   declares, or an owner prefix of one;
 * - it imports S (its module specifiers resolve to S's path — the resolver the
 *   test-support classification resolves unwalked importers with).
 *
 * The safe default is the finding: a test the tree read could not parse, a
 * scope with no leading identifier, a source whose declarations were not read
 * — none of them covers, so a miss only leaves noise and never hides a gap.
 */

import type { RelPath } from "../../../../contracts/types/codegraph.js";
import { resolveUnwalkedImportEdges } from "../../../../domains/trajectory/codegraph/symbols/index.js";
import { classify } from "../../../../primitives/paths/index.js";
import type { IncompleteChangePartner } from "../../../public/dto/review.js";
import type { ReviewTreeChunkReader, ReviewTreeChunkRow } from "./review-section-provider.js";

/** The touched test whose subject is a finding's source, and the symbol it names. */
export interface TestPartnerCoverage {
  coveredBy: RelPath;
  subject: string;
}

/** Answers, per finding, the touched test that covers its missing test partner, if any. */
export type TestPartnerCoverageLookup = (finding: IncompleteChangePartner) => TestPartnerCoverage | undefined;

/** An identifier, optionally `::`-qualified (`Billing::Invoice`) — the whole leading token of a scope name. */
const LEADING_IDENTIFIER = /^[\p{L}_$][\p{L}\p{N}_$]*(?:::[\p{L}_$][\p{L}\p{N}_$]*)*/u;
/** Where a symbolId's owner prefix ends: a member (`#`, `.`) or a namespace (`::`) separator. */
const SYMBOL_SEPARATOR = /::|#|\./g;
/** The chunker's split-part suffix (`Class#method#part2`) — not part of the declared symbol. */
const PART_SUFFIX = /#part\d+$/;

const NOTHING_COVERED: TestPartnerCoverageLookup = () => undefined;

/**
 * Read the subjects and imports of `touchedTests`, and the declarations of the
 * sources whose test partner is missing, from the working tree — one read, only
 * when a test finding and a touched test both exist.
 */
export async function readTestPartnerCoverage(
  partners: readonly IncompleteChangePartner[],
  touchedTests: readonly RelPath[],
  readTreeChunks: ReviewTreeChunkReader | undefined,
): Promise<TestPartnerCoverageLookup> {
  const sources = [
    ...new Set(
      partners
        .filter((finding) => finding.partnerKind === "test" && !classify(finding.file).isTest)
        .map((finding) => finding.file),
    ),
  ];
  if (readTreeChunks === undefined || sources.length === 0 || touchedTests.length === 0) return NOTHING_COVERED;
  const rowsByPath = await readTreeChunks([...touchedTests, ...sources]);

  const declaredBySource = new Map(sources.map((source) => [source, declaredSymbols(rowsByPath.get(source))]));
  const subjectsByTest = new Map<RelPath, Set<string>>();
  const importsByTest = new Map<RelPath, { isTest: boolean; specifiers: readonly string[] }>();
  for (const test of touchedTests) {
    const testRows = (rowsByPath.get(test) ?? []).filter((row) => row.isTest === true);
    const subjects = new Set(testRows.flatMap((row) => leadingIdentifierOf(row.symbolId)));
    if (subjects.size === 0) continue;
    subjectsByTest.set(test, subjects);
    importsByTest.set(test, { isTest: true, specifiers: [...new Set(testRows.flatMap((row) => row.imports ?? []))] });
  }
  if (subjectsByTest.size === 0) return NOTHING_COVERED;

  const importedSourcesByTest = new Map<RelPath, Set<RelPath>>();
  for (const { sourceRelPath, targetRelPath } of resolveUnwalkedImportEdges(importsByTest, sources)) {
    const imported = importedSourcesByTest.get(sourceRelPath) ?? new Set<RelPath>();
    imported.add(targetRelPath);
    importedSourcesByTest.set(sourceRelPath, imported);
  }
  const coveringTests = [...subjectsByTest.keys()].sort();

  return (finding) => {
    if (finding.partnerKind !== "test") return undefined;
    const declared = declaredBySource.get(finding.file);
    if (declared === undefined || declared.size === 0) return undefined;
    for (const test of coveringTests) {
      if (!importedSourcesByTest.get(test)?.has(finding.file)) continue;
      const subject = [...(subjectsByTest.get(test) ?? [])].sort().find((name) => declared.has(name));
      if (subject !== undefined) return { coveredBy: test, subject };
    }
    return undefined;
  };
}

/** The leading identifier of a test row's top scope — its symbolId starts with the top scope's name. */
function leadingIdentifierOf(symbolId: string | undefined): string[] {
  const match = symbolId === undefined ? null : LEADING_IDENTIFIER.exec(symbolId);
  return match === null ? [] : [match[0]];
}

/** Every symbol the source's non-test rows declare, with each owner prefix (`A#b` declares `A` too). */
function declaredSymbols(rows: readonly ReviewTreeChunkRow[] | undefined): Set<string> {
  const declared = new Set<string>();
  for (const row of rows ?? []) {
    if (row.isTest === true || row.symbolId === undefined) continue;
    const symbolId = row.symbolId.replace(PART_SUFFIX, "");
    declared.add(symbolId);
    for (const separator of symbolId.matchAll(SYMBOL_SEPARATOR)) declared.add(symbolId.slice(0, separator.index));
  }
  return declared;
}
