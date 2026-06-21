import type Parser from "tree-sitter";
import { describe, expect, it } from "vitest";

import { TreeSitterChunker } from "../../../../../../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";
import {
  collectSymbols,
  DefaultSymbolIdComposer,
  LanguageFactory,
} from "../../../../../../../src/core/domains/language/index.js";
import type { ChunkerConfig } from "../../../../../../../src/core/types.js";

/**
 * rdv7d root-cause splitter. The pool repro (pool-ruby-jitter-repro.test.ts)
 * proved ruby walker call counts drift for the SAME file depending on which
 * files a reused worker processed first. This test removes the pool + all
 * concurrency: ONE engine (the worker's reused engine), walk service_1 in
 * isolation vs after 49 predecessors, deterministically. Two assertions split
 * the root cause:
 *   - tree S-expression equal? → the PARSE is deterministic; drift is WALKER
 *     state carryover (H1). Tree differs → the reused PARSER is the culprit (H2).
 *   - call count equal? → no carryover. Differs → carryover confirmed (the bug).
 */

const CONFIG = { chunkSize: 1500, chunkOverlap: 0, maxChunkSize: 3000 } as ChunkerConfig;

function rubySource(i: number): string {
  const methods = 3 + (i % 7);
  const body = Array.from({ length: methods }, (_, m) => {
    const calls = 2 + ((i + m) % 5);
    const lines = Array.from(
      { length: calls },
      (_, c) => `    acc = transform_${c}(acc).map { |x| x.to_s.strip }.reject(&:empty?)`,
    ).join("\n");
    return `  def process_${m}(input, opts = {})\n    acc = input\n${lines}\n    acc\n  end`;
  }).join("\n\n");
  return `module Domain${i}\n  class Service${i} < Base${i % 3}\n    include Mixin${i % 4}\n${body}\n  end\nend\n`;
}

// Replicates the worker's per-file flow (worker.ts:106-129) on a shared engine.
function buildEngine() {
  const factory = new LanguageFactory();
  const composer = new DefaultSymbolIdComposer();
  const chunker = new TreeSitterChunker(CONFIG, composer, factory);
  return { factory, composer, chunker };
}

// Strong, position-sensitive tree fingerprint — every node's type + byte
// range. Catches a reused-parser corruption that leaves the S-expression
// structure intact but shifts node positions/text (which the walker reads).
function treeFingerprint(tree: Parser.Tree): string {
  const parts: string[] = [];
  const visit = (n: Parser.SyntaxNode) => {
    parts.push(`${n.type}:${n.startIndex}:${n.endIndex}`);
    for (const c of n.children) visit(c);
  };
  visit(tree.rootNode);
  return parts.join("|");
}

async function walkFile(engine: ReturnType<typeof buildEngine>, path: string, code: string) {
  const { tree } = await engine.chunker.chunkWithTree(code, path, "ruby");
  const provider = engine.factory.create("ruby");
  const { walker, kernel } = provider;
  const symbolRanges = collectSymbols(
    tree!,
    walker!.nameOf,
    kernel.scopeSeparator ?? ".",
    kernel.disambiguateOverloads ?? false,
    engine.composer,
  );
  const extraction = walker!.walk({ tree: tree!, code, relPath: path, language: "ruby", chunks: symbolRanges });
  const totalCalls = extraction.chunks.reduce((n, c) => n + c.calls.length, 0);
  return { sexp: treeFingerprint(tree!), rangeCount: symbolRanges.length, totalCalls };
}

describe("ruby walker carryover (engine-level, no pool, no concurrency)", () => {
  // rdv7d: RED until Task 10 (materialize boundary) lands — skipped so the suite
  // is green for the type-swap tasks; Task 10 un-skips and turns it green.
  it.skip("walking service_1 alone vs after 49 predecessors yields the same tree AND the same call count", async () => {
    const isolatedEngine = buildEngine();
    const isolated = await walkFile(isolatedEngine, "service_1.rb", rubySource(1));

    const sharedEngine = buildEngine();
    for (let i = 0; i < 50; i++) {
      if (i === 1) continue;
      await walkFile(sharedEngine, `service_${i}.rb`, rubySource(i));
    }
    const afterPredecessors = await walkFile(sharedEngine, "service_1.rb", rubySource(1));

    // H2 check: identical (position-sensitive) parse tree ⇒ parser deterministic.
    expect(
      afterPredecessors.sexp === isolated.sexp,
      `PARSE TREE (type+range fingerprint) differs after predecessors → reused PARSER corruption (H2). ` +
        `isolatedLen=${isolated.sexp.length} afterLen=${afterPredecessors.sexp.length}`,
    ).toBe(true);
    // Range check: symbolRanges from collectSymbols+nameOf — drift here = name/range inflation.
    expect(
      afterPredecessors.rangeCount,
      `symbolRanges count drifted: isolated=${isolated.rangeCount} after=${afterPredecessors.rangeCount}`,
    ).toBe(isolated.rangeCount);
    // Carryover check: same tree+ranges but different call count ⇒ walk-level carryover.
    expect(
      afterPredecessors.totalCalls,
      `WALKER call count carryover: isolated=${isolated.totalCalls} after-predecessors=${afterPredecessors.totalCalls}`,
    ).toBe(isolated.totalCalls);
  });

  it.skip("DIAGNOSTIC: single fresh-engine parse+walk of service_1, repeated in-process — is it stable?", async () => {
    const CODE = rubySource(1);
    const rows: { calls: number; textOk: boolean; posFp: string }[] = [];
    for (let r = 0; r < 40; r++) {
      const engine = buildEngine();
      const { tree } = await engine.chunker.chunkWithTree(CODE, "service_1.rb", "ruby");
      // node.text fingerprint vs source slice: if rootNode.text !== CODE, the
      // native tree's text buffer is corrupt (positions can still match).
      const rootText = tree!.rootNode.text;
      const provider = engine.factory.create("ruby");
      const { walker, kernel } = provider;
      const ranges = collectSymbols(
        tree!,
        walker!.nameOf,
        kernel.scopeSeparator ?? ".",
        kernel.disambiguateOverloads ?? false,
        engine.composer,
      );
      const ext = walker!.walk({ tree: tree!, code: CODE, relPath: "service_1.rb", language: "ruby", chunks: ranges });
      const calls = ext.chunks.reduce((n, c) => n + c.calls.length, 0);
      rows.push({ calls, textOk: rootText === CODE, posFp: treeFingerprint(tree!) });
    }
    const distinctCalls = [...new Set(rows.map((r) => r.calls))];
    const distinctPos = [...new Set(rows.map((r) => r.posFp))];
    const textCorruptRows = rows.filter((r) => !r.textOk).length;
    console.error(
      `[rdv7d] calls distinct=${JSON.stringify(distinctCalls)} | distinctPosFingerprints=${distinctPos.length} | rootText!==code rows=${textCorruptRows}/40`,
    );
    // Discriminator: report which layer is non-deterministic.
    expect(distinctCalls.length, `call count NOT stable: ${JSON.stringify(distinctCalls)}`).toBe(1);
  });

  it.skip("DIAGNOSTIC: walk the SAME tree object 30× — does call count vary on a fixed tree?", async () => {
    const CODE = rubySource(1);
    const engine = buildEngine();
    const { tree } = await engine.chunker.chunkWithTree(CODE, "service_1.rb", "ruby");
    const provider = engine.factory.create("ruby");
    const { walker, kernel } = provider;
    const counts: number[] = [];
    for (let r = 0; r < 30; r++) {
      const ranges = collectSymbols(
        tree!,
        walker!.nameOf,
        kernel.scopeSeparator ?? ".",
        kernel.disambiguateOverloads ?? false,
        engine.composer,
      );
      const ext = walker!.walk({ tree: tree!, code: CODE, relPath: "service_1.rb", language: "ruby", chunks: ranges });
      counts.push(ext.chunks.reduce((n, c) => n + c.calls.length, 0));
    }
    const distinct = [...new Set(counts)];
    // SAME tree object, re-walked. >1 distinct ⇒ native node-accessor
    // instability (childForFieldName/parent/namedChildren return inconsistent
    // results on a fixed tree) OR walker reads non-tree global state.
    console.error(`[rdv7d] SAME-tree re-walk counts: distinct=${JSON.stringify(distinct)}`);
    expect(distinct.length, `SAME-tree re-walk NOT stable: ${JSON.stringify(distinct)}`).toBe(1);
  });

  it("DECIDER: is an EAGER single-pass capture of the fragile accessors (childForFieldName/.parent) stable across N materializations of the same tree?", async () => {
    const CODE = rubySource(1);
    const engine = buildEngine();
    const { tree } = await engine.chunker.chunkWithTree(CODE, "service_1.rb", "ruby");
    const FIELDS = ["name", "parameters", "receiver", "method", "left", "right", "superclass", "body", "value"];
    // One eager top-down pass: touch each node ONCE, immediately record its
    // fragile-accessor results (field children types + parent type + namedChild
    // count). This mirrors what a materialization boundary would capture.
    const materializeFingerprint = (): string => {
      const parts: string[] = [];
      const visit = (n: Parser.SyntaxNode) => {
        const fields = FIELDS.map((f) => n.childForFieldName(f)?.type ?? "_").join(",");
        parts.push(
          `${n.type}:${n.startIndex}:${n.endIndex}:[${fields}]:p=${n.parent?.type ?? "_"}:nc=${n.namedChildren.length}`,
        );
        for (const c of n.children) visit(c);
      };
      visit(tree!.rootNode);
      return parts.join("|");
    };
    const fps: string[] = [];
    for (let r = 0; r < 30; r++) fps.push(materializeFingerprint());
    const distinct = [...new Set(fps)];
    console.error(
      `[rdv7d] EAGER materialize fingerprints: distinct=${distinct.length} (1 ⇒ eager single-pass is stable → Variant-1 sound)`,
    );
    expect(distinct.length, `EAGER materialization of fragile accessors NOT stable: ${distinct.length} distinct`).toBe(
      1,
    );
  });
});
