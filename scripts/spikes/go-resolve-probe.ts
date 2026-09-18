/**
 * go-resolve-probe.ts (bd tea-rags-mcp-e6xx)
 *
 * Named-edge probe for the Go resolver over a real corpus, offline: no Qdrant,
 * no embeddings, no DuckDB, no index run. It drives the SAME walk and the SAME
 * production resolver `codegraph-chain-tally.ts --time-only` drives (it calls
 * that harness's exported `run`), and adds the two views the tally does not
 * print: every call site of a watched member with the target it resolved to,
 * and the residual unresolved sites grouped by receiver text.
 *
 * The four edges the e6xx report named on gin are the default watch list:
 *   - `c.JSON(...)`            → `Context#JSON`       (callers of JSON)
 *   - `engine.GET(...)`        → `RouterGroup#GET`    (promotion through embedding)
 *   - `engine.handleHTTPRequest(c)` in `Engine#ServeHTTP`
 *   - `c.Render(...)`          in `Context#JSON`
 * plus `combineHandlers`, the promoted `RouterGroup` method gin's own `Engine`
 * code calls on an `*Engine` receiver.
 *
 * Usage:
 *   env -u NODE_OPTIONS npx tsx scripts/spikes/go-resolve-probe.ts \
 *     --corpus <abs path to gin> [--member JSON,GET,...] [--residual 40]
 */

import { posix, resolve as resolvePath } from "node:path";

import type { SymbolResolutionTarget } from "../../src/core/contracts/types/codegraph.js";
import { formatKindStatsBlock, run } from "../codegraph-chain-tally.js";

const DEFAULT_MEMBERS = ["JSON", "GET", "handleHTTPRequest", "Render", "combineHandlers"];

function read(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function describeTarget(target: SymbolResolutionTarget | null): string {
  return target === null ? "UNRESOLVED" : `${target.targetSymbolId ?? "(file-only)"} @ ${target.targetRelPath}`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const corpus = resolvePath(read(argv, "--corpus") ?? process.cwd());
  const members = (read(argv, "--member") ?? DEFAULT_MEMBERS.join(",")).split(",").filter(Boolean);
  const residualCap = Number(read(argv, "--residual") ?? 40);

  const result = await run(corpus, "go", null, Number.MAX_SAFE_INTEGER, true, true, {
    timeOnly: true,
    kindStats: true,
  });
  const out: string[] = [`CORPUS ${corpus}`, `  ${result.files} files · ${result.rows.length} call sites`];

  const resolvedCount = result.rows.filter((row) => row.runnerAnswer !== null).length;
  out.push(`  resolved ${resolvedCount} · unresolved ${result.rows.length - resolvedCount}`);
  if (result.kindStats !== undefined) out.push(...formatKindStatsBlock(result.kindStats, undefined));

  out.push("", "WATCHED MEMBERS");
  for (const member of members) {
    const sites = result.rows.filter((row) => row.member === member);
    out.push(`  ${member} — ${sites.length} site(s)`);
    for (const row of sites) {
      out.push(
        `    ${row.relPath}:${row.startLine} ${String(row.receiver)}.${row.member} → ${describeTarget(row.runnerAnswer)}`,
      );
    }
  }

  // A bare `foo()` in Go names the caller's OWN package (or a dot-import), so a
  // bare-call edge landing in another directory is a fabrication unless a
  // dot-import explains it — listed, so every one can be checked by hand. A
  // package-qualified generic call (`pkg.F[T](x)`) arrives receiver-less too,
  // with the qualifier in its member; it crosses packages by construction.
  const crossPackage = result.rows.filter(
    (row) =>
      row.receiver === null &&
      !/^[^[]*\./.test(row.member) &&
      row.runnerAnswer !== null &&
      posix.dirname(row.relPath) !== posix.dirname(row.runnerAnswer.targetRelPath),
  );
  out.push("", `BARE-CALL EDGES CROSSING A PACKAGE BOUNDARY: ${crossPackage.length}`);
  for (const row of crossPackage) {
    out.push(`    ${row.relPath}:${row.startLine} ${row.member} → ${describeTarget(row.runnerAnswer)}`);
  }

  // Residual unresolved sites keyed by receiver text: the head of the list is
  // where a resolver change buys the most, and a receiver that repeats is one
  // idiom, not many.
  const residual = new Map<string, number>();
  for (const row of result.rows) {
    if (row.runnerAnswer !== null || row.receiver === null) continue;
    residual.set(row.receiver, (residual.get(row.receiver) ?? 0) + 1);
  }
  const ranked = [...residual.entries()].sort((a, b) => b[1] - a[1]).slice(0, residualCap);
  out.push("", `RESIDUAL UNRESOLVED RECEIVERS (top ${ranked.length} of ${residual.size})`);
  for (const [receiver, count] of ranked) out.push(`  ${String(count).padStart(4)}  ${receiver}`);

  process.stdout.write(`${out.join("\n")}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
