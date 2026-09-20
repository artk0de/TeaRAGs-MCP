/**
 * Layer B — the per-grammar inventory of field names materialization loses.
 *
 * Layer A next door (`extraction-parity.test.ts`) catches a walker that READS a
 * lost field today. This one catches the collision itself, before any walker
 * reads it: it asks both trees for every field name any language module reads,
 * at every node of a synthetic fixture, and pins the set of `(nodeType,
 * fieldName)` pairs the native tree answers and the materialized tree does not.
 *
 * Why pin a set nobody reads: `tea-rags-mcp-6fsk` plans a `tree-sitter-*` major
 * bump, and a grammar bump can register a child under a second field name at
 * any time. Nothing else in the suite would notice — the pairs below are inert
 * until a walker reads one, and on the day it does the failure is silent (a
 * value in every spec, `null` in production; see the probe helper's header for
 * how Swift lost its whole stored-property channel that way). A moved set here
 * fails with the exact list, on the bump commit, months before someone writes
 * the read.
 *
 * The pins are MEASURED, not designed. Regenerate by running this file and
 * copying the reported pairs; each entry's presence is a fact about the
 * grammar, and a pair DISAPPEARING is as interesting as one appearing.
 */

import { describe, expect, it } from "vitest";

import {
  bothTreesOf,
  distinctGrammarExtensions,
  findMaterializedFieldLosses,
  findParseFailures,
  MATERIALIZATION_PARITY_CORPUS,
  surveyWalkerFieldReads,
} from "./__helpers__/materialization-parity-probe.js";

/**
 * Measured `(nodeType, fieldName)` pairs per grammar, over the synthetic corpus.
 *
 * Empty means the grammar registers no child under two names any walker reads —
 * the state every grammar here but TypeScript and Swift is in. An exhaustive
 * run over real corpora (huginn, octokit, express, flask, gin, commons-lang,
 * ripgrep, homebrew; ~2.5M nodes) found the same, so the empties are a property
 * of the grammars rather than of a thin fixture.
 */
const PINNED_FIELD_LOSSES: Readonly<Record<string, readonly string[]>> = {
  /**
   * All three are TYPE-position nodes. The TypeScript walker reads `object` and
   * `property` only under explicit `member_expression` / `subscript_expression`
   * type guards, and reads no `operator` at all, so none is reachable today —
   * they are pinned to catch a future read, not to record a live defect.
   */
  typescript: ["literal_type.operator", "type_query.object", "type_query.property"],
  "typescript-tsx": [],
  javascript: [],
  python: [],
  ruby: [],
  go: [],
  java: [],
  rust: [],
  /**
   * KNOWN-LOSSY, and the walker avoids every one of them. Swift types are read
   * POSITIONALLY — `swiftTypeNodeAfter(node, ":")` for parameters and
   * annotations, the node after `->` for a signature — and the walker's
   * `childForFieldName` reads sit inside a `switch (node.type)` whose cases
   * never name a shape below. That positional read IS the fix for the
   * production failure described in the file header; these pins make sure a
   * later "simplification" back to `childForFieldName("type")` cannot land
   * quietly.
   *
   * The same 15 shapes, in the same order, are what the real-corpus probe found
   * (6,634 losing sites) — this fixture reproduces the grammar's full inventory,
   * not a sample of it.
   */
  swift: [
    "as_expression.type",
    "check_expression.type",
    "dictionary_type.key",
    "dictionary_type.value",
    "function_declaration.return_type",
    "function_type.return_type",
    "lambda_function_type.return_type",
    "lambda_parameter.type",
    "parameter.type",
    "protocol_function_declaration.return_type",
    "subscript_declaration.return_type",
    "switch_pattern.name",
    "tuple_type_item.type",
    "type_annotation.type",
    "typealias_declaration.value",
  ],
  bash: [],
};

describe("materialization field-loss inventory — candidate field names", () => {
  it("derives the candidate set from the language sources, with every call site readable", () => {
    const survey = surveyWalkerFieldReads();
    expect(survey.names.length).toBeGreaterThan(0);
    // A `childForFieldName(someVariable)` call would put a field name outside
    // the probe's reach and leave that read unguarded. There are none today;
    // the day one appears, this fails instead of quietly narrowing the guard.
    expect(survey.literalCallSites).toBe(survey.callSites);
  });
});

describe("materialization field-loss inventory — corpus coverage", () => {
  it("has a fixture for every grammar the codegraph table can load", () => {
    const covered = new Set(MATERIALIZATION_PARITY_CORPUS.map((fixture) => fixture.extension));
    const uncovered = distinctGrammarExtensions().filter((extension) => !covered.has(extension));
    expect(uncovered).toEqual([]);
  });

  it.each(MATERIALIZATION_PARITY_CORPUS)("$grammarKey parses its fixture cleanly", (fixture) => {
    // A typo in a fixture degrades into ERROR nodes, which parse to nothing and
    // shrink the guard's reach without failing anything.
    const { native } = bothTreesOf(fixture);
    expect(findParseFailures(native.rootNode)).toEqual([]);
  });
});

describe("materialization field-loss inventory — per-grammar pins", () => {
  const fieldNames = surveyWalkerFieldReads().names;

  it.each(MATERIALIZATION_PARITY_CORPUS)("$grammarKey loses exactly the pinned field names", (fixture) => {
    const { native, materialized } = bothTreesOf(fixture);
    const losses = findMaterializedFieldLosses(native.rootNode, materialized.rootNode, fieldNames);
    const report = losses.map((loss) => `${loss.pair} x${loss.occurrences} e.g. "${loss.example}"`).join("\n");
    expect(
      losses.map((loss) => loss.pair),
      `${fixture.grammarKey} measured:\n${report}`,
    ).toEqual([...PINNED_FIELD_LOSSES[fixture.grammarKey]]);
  });
});
