/**
 * Reproduce the PRODUCTION `resolveSuccessRate` buckets offline, without an
 * index run (bd tea-rags-mcp-nl93h follow-up).
 *
 * `cg_run_stats` is the only supported read path for the per-receiver-kind
 * breakdown, and it is overwritten by every finalize — so the numbers behind a
 * measurement evaporate as soon as anything else indexes. This walks the same
 * corpus with the same walker, the same `TSCallResolver`, and the same miss
 * classifiers `resolution-runner.classifyMiss` uses, in the same order, so the
 * per-kind tally it prints is the one a real run would persist.
 *
 * It also splits the residual (the recall hole) by how many candidates the
 * global short-name index holds for the callee, which is what decides whether
 * strict `pickSingleCandidate` COULD have picked a target at all.
 *
 * Extraction helpers are imported from the oracle rather than copied — the Ruby
 * harness records a real measurement bug caused by a hand-copied helper drifting.
 *
 * Usage: npx tsx scripts/spikes/live-resolve-buckets.ts [--target src]
 */

import { relative, resolve as resolvePath } from "node:path";

import type { CallRef, FileExtraction, RelPath } from "../../src/core/contracts/types/codegraph.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../src/core/domains/language/index.js";
import { loadTsConfig, TSCallResolver } from "../../src/core/domains/language/typescript/index.js";
import { classifyReceiverKind } from "../../src/core/domains/trajectory/codegraph/symbols/receiver-kind.js";
import { InMemoryGlobalSymbolTable } from "../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { buildCallContext, buildSymbolDefs, collectSourceFiles, extractFile } from "../ts-codegraph-typechecker-oracle.js";

interface Tally {
  attempted: number;
  resolved: number;
  externalSkipped: number;
  noInProjectDef: number;
  coreAmbiguous: number;
  /** The residual — `classifyMiss` fell through every branch. */
  residual: number;
  /** Residual split by `lookupByShortName(member).length`. */
  residualByCandidates: Map<number, number>;
  /** Residual callee short names, for the collision read-out. */
  residualNames: Map<string, number>;
  /** `noInProjectDef` callee short names — the bucket grz07 moves calls out of. */
  noDefNames: Map<string, number>;
}

const emptyTally = (): Tally => ({
  attempted: 0,
  resolved: 0,
  externalSkipped: 0,
  noInProjectDef: 0,
  coreAmbiguous: 0,
  residual: 0,
  residualByCandidates: new Map(),
  residualNames: new Map(),
  noDefNames: new Map(),
});

const bump = <K>(m: Map<K, number>, k: K): void => m.set(k, (m.get(k) ?? 0) + 1);

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const targetArg = argv.includes("--target") ? argv[argv.indexOf("--target") + 1] : "src";
  const skipArg = argv.includes("--skip") ? argv[argv.indexOf("--skip") + 1] : "";
  const skips = skipArg.split(",").filter(Boolean);
  const repoRoot = process.cwd();
  const target = resolvePath(repoRoot, targetArg);

  const composer = new DefaultSymbolIdComposer();
  const factory = new LanguageFactory();
  const resolver = new TSCallResolver(loadTsConfig(repoRoot), "strict", repoRoot);
  const symbolTable = new InMemoryGlobalSymbolTable();

  // Pass 1 — whole symbol table first, exactly as production does.
  const all: RelPath[] = await collectSourceFiles(repoRoot, target);
  const files = all.filter((f) => !skips.some((s) => f.startsWith(s)));
  const extractions: FileExtraction[] = [];
  const classExtends: Record<string, string> = {};
  for (const relPath of files) {
    const extraction = extractFile(repoRoot, relPath, composer, factory);
    if (extraction === null) continue;
    symbolTable.upsertFile(relPath, buildSymbolDefs(extraction));
    Object.assign(classExtends, extraction.classExtends ?? {});
    extractions.push(extraction);
  }

  // Pass 2 — resolve, then classify every miss in `classifyMiss` order.
  const byKind = new Map<string, Tally>();
  const tallyFor = (kind: string): Tally => {
    const existing = byKind.get(kind);
    if (existing) return existing;
    const fresh = emptyTally();
    byKind.set(kind, fresh);
    return fresh;
  };

  for (const extraction of extractions) {
    for (const chunk of extraction.chunks) {
      const ctx = buildCallContext(extraction, chunk, classExtends, symbolTable);
      for (const call of (chunk.calls ?? []) as CallRef[]) {
        if (call.dispatch !== undefined) continue; // fan-out contract, not single-target
        const kind = classifyReceiverKind(call, chunk.localBindings);
        const t = tallyFor(kind);
        t.attempted += 1;

        if (resolver.resolve(call, ctx)) {
          t.resolved += 1;
          continue;
        }
        // classifyMiss order is load-bearing — first match wins.
        if (call.dynamicSend === true) continue; // `unresolvable`, Ruby-only
        if (resolver.targetsExternalImport?.(call, ctx)) {
          t.externalSkipped += 1;
          continue;
        }
        const candidates = symbolTable.lookupByShortName(call.member).length;
        if (candidates === 0) {
          t.noInProjectDef += 1;
          bump(t.noDefNames, call.member);
          continue;
        }
        if (resolver.targetsCoreAmbiguousMember?.(call, ctx)) {
          t.coreAmbiguous += 1;
          continue;
        }
        t.residual += 1;
        bump(t.residualByCandidates, Math.min(candidates, 5));
        bump(t.residualNames, call.member);
      }
    }
  }

  const rate = (t: Tally): number => (t.resolved + t.residual === 0 ? 0 : t.resolved / (t.resolved + t.residual));
  const kinds = [...byKind.entries()].sort((a, b) => b[1].attempted - a[1].attempted);

  process.stdout.write(
    `\nLIVE RESOLVE BUCKETS — ${relative(repoRoot, target) || "."} @ ${repoRoot}\n` +
      `files ${extractions.length} · symbols ${symbolTable.size()}\n\n` +
      "kind         rate  resolved/denom | attempted  extSkip  noDef  coreAmb  residual\n" +
      "---------------------------------------------------------------------------------\n",
  );
  for (const [kind, t] of kinds) {
    process.stdout.write(
      `${kind.padEnd(11)} ${rate(t).toFixed(2)}  ${String(t.resolved).padStart(5)}/${String(t.resolved + t.residual).padEnd(6)} | ` +
        `${String(t.attempted).padStart(9)} ${String(t.externalSkipped).padStart(8)} ${String(t.noInProjectDef).padStart(6)} ` +
        `${String(t.coreAmbiguous).padStart(8)} ${String(t.residual).padStart(9)}\n`,
    );
  }

  for (const [kind, t] of kinds) {
    if (t.residual === 0) continue;
    const spread = [...t.residualByCandidates.entries()].sort((a, b) => a[0] - b[0]);
    process.stdout.write(
      `\n${kind} residual ${t.residual} by short-name candidate count ` +
        `(strict pickSingleCandidate can only pick when count === 1):\n  ` +
        spread.map(([n, c]) => `${n === 5 ? "5+" : n}:${c}`).join("  ") +
        "\n",
    );
    const top = [...t.residualNames.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
    process.stdout.write(`  top callees: ${top.map(([n, c]) => `${n}(${c})`).join(", ")}\n`);
  }

  const bare = byKind.get("bareCall");
  if (bare) {
    const names = [...bare.noDefNames.entries()].sort((a, b) => b[1] - a[1]);
    process.stdout.write(
      `\nbareCall noInProjectDef ${bare.noInProjectDef} over ${names.length} distinct callee names\n` +
        `  top: ${names
          .slice(0, 30)
          .map(([n, c]) => `${n}(${c})`)
          .join(", ")}\n`,
    );
  }
  process.stdout.write("\n");
}

void main();
