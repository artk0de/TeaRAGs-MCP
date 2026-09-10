/**
 * Split the persisted Ruby entry-hub edges by call-site SHAPE, read-only
 * (bd tea-rags-mcp-4vg1i).
 *
 * `cg_run_stats.unnarrowed_template` says HOW MANY resolved entry calls stopped
 * at a shared self-dispatch node, per receiver kind. It cannot say WHICH, and
 * the three shapes the field report separates need the call site itself:
 *
 *   1. non-constant receiver — nothing to narrow WITH; the edge to the shared
 *      class method is the honest answer and the counter over-reports it
 *   2. constant receiver whose class is absent from `cg_symbols` — nothing to
 *      narrow TO, because the concrete type was never indexed
 *   3. constant receiver whose class IS indexed — the genuine defect
 *
 * The entry registry is rebuilt from the PERSISTED pass-1 slices
 * (`cg_pass1_aggregates`, migration 021) rather than from a run:
 * `collectSelfInstantiatingClassMethods` is pure over `selfDispatchMethods`, so
 * the set this reproduces is byte-identical to the one pass-2 resolved against.
 * The TEMPLATE half of the registry needs a live symbol-table probe and is NOT
 * reproduced here — the field report's degraded edges all pointed at the class
 * method (`KindOfService.call`), which is the half that is pure.
 *
 * Counts EDGES, not call sites: `cg_symbols_edges_method`'s primary key is
 * (source_symbol_id, call_expression, target_symbol_id), so two identical calls
 * in one method collapse to one row. Shape PROPORTIONS carry over; the absolute
 * total reads at or below the run-stats tally by construction.
 *
 * Read-only, and attached under an in-memory database so the join scratch never
 * touches the graph: safe to run against an index another process may open.
 *
 * Usage: node scripts/spikes/ruby-entry-hub-shapes.js <path-to.duckdb> [--samples N]
 */
import { DuckDBInstance } from "@duckdb/node-api";

const dbPath = process.argv[2];
if (!dbPath) {
  process.stderr.write("usage: node scripts/spikes/ruby-entry-hub-shapes.js <path-to.duckdb> [--samples N]\n");
  process.exit(1);
}
const sampleIdx = process.argv.indexOf("--samples");
const sampleCount = sampleIdx === -1 ? 15 : Number(process.argv[sampleIdx + 1]);

/** Mirrors `classifyReceiverKind`'s CONST_RE — the only receiver shape the entry strategy can narrow. */
const CONST_RE = /^[A-Z][A-Za-z0-9_]*(?:::[A-Z][A-Za-z0-9_]*)*$/;

/**
 * The receiver text of a call expression, or null for a bare call. The walker
 * writes `call_expression` as the source-level callee, so the receiver is
 * everything before the LAST `.` — `Ns::Svc.call` → `Ns::Svc`, `handler.call` →
 * `handler`, `call` → null. `&.` safe-navigation leaves a trailing `&`, which
 * fails CONST_RE and lands in the non-constant bucket, correctly.
 */
function receiverOf(callExpression) {
  const dot = callExpression.lastIndexOf(".");
  return dot <= 0 ? null : callExpression.slice(0, dot);
}

const instance = await DuckDBInstance.create(":memory:");
const connection = await instance.connect();
await connection.run(`ATTACH '${dbPath.replace(/'/g, "''")}' AS g (READ_ONLY)`);

// 1. Rebuild the self-instantiating class-method registry from persisted slices.
const pass1 = await connection.runAndReadAll(
  "SELECT rel_path, aggregates_json FROM g.cg_pass1_aggregates WHERE language = 'ruby'",
);
const entrySymbolIds = new Set();
let slicesWithMethods = 0;
for (const row of pass1.getRowObjectsJS()) {
  let payload;
  try {
    payload = JSON.parse(row.aggregates_json);
  } catch {
    continue; // a malformed blob contributed nothing to the run either
  }
  const methods = payload.selfDispatchMethods ?? [];
  if (methods.length > 0) slicesWithMethods += 1;
  for (const m of methods) {
    const classForm = m.symbolId.includes(".") && !m.symbolId.includes("#");
    if (classForm && (m.selfHookCandidates ?? []).includes("new")) entrySymbolIds.add(m.symbolId);
  }
}

process.stdout.write(
  `pass1 slices: ${pass1.getRowObjectsJS().length} ruby · ${slicesWithMethods} declaring self-dispatch methods\n` +
    `self-instantiating class-method entries: ${entrySymbolIds.size}\n`,
);
if (entrySymbolIds.size === 0) {
  process.stdout.write("no entries — the index predates migration 021 or was never recomputed since\n");
  process.exit(0);
}

// 2. Join the entry set against the persisted method edges.
await connection.run("CREATE TABLE entries (sid VARCHAR)");
const appender = await connection.createAppender("entries");
for (const sid of entrySymbolIds) {
  appender.appendVarchar(sid);
  appender.endRow();
}
appender.closeSync();

const edges = await connection.runAndReadAll(
  "SELECT e.call_expression, e.target_symbol_id, e.source_rel_path FROM g.cg_symbols_edges_method e " +
    "JOIN entries n ON e.target_symbol_id = n.sid",
);
const hubEdges = edges.getRowObjectsJS();

// 3. Bucket by receiver shape.
const constantReceivers = new Map(); // receiver → edge count
const constantPairs = new Map(); // `receiver → target` → edge count
let bare = 0;
let nonConstant = 0;
const nonConstantSamples = [];
for (const e of hubEdges) {
  const receiver = receiverOf(e.call_expression);
  if (receiver === null) {
    bare += 1;
    continue;
  }
  if (!CONST_RE.test(receiver)) {
    nonConstant += 1;
    if (nonConstantSamples.length < sampleCount) nonConstantSamples.push(e);
    continue;
  }
  constantReceivers.set(receiver, (constantReceivers.get(receiver) ?? 0) + 1);
  const pair = `${e.call_expression} → ${e.target_symbol_id}`;
  constantPairs.set(pair, (constantPairs.get(pair) ?? 0) + 1);
}

// 4. Shape 2 vs 3 — is the constant receiver's class in the symbol index at all?
//    A class body is itself a `cg_symbols` row whose symbol_id is the bare fq
//    name (no `#`, no `.`), so equality is the whole test.
await connection.run("CREATE TABLE receivers (name VARCHAR)");
const rAppender = await connection.createAppender("receivers");
for (const name of constantReceivers.keys()) {
  rAppender.appendVarchar(name);
  rAppender.endRow();
}
rAppender.closeSync();
const indexed = await connection.runAndReadAll(
  "SELECT DISTINCT r.name FROM receivers r JOIN g.cg_symbols s ON s.symbol_id = r.name",
);
const indexedNames = new Set(indexed.getRowObjectsJS().map((r) => r.name));

let shape2Edges = 0;
let shape3Edges = 0;
const shape2Names = [];
const shape3Names = [];
for (const [name, count] of constantReceivers) {
  if (indexedNames.has(name)) {
    shape3Edges += count;
    shape3Names.push([name, count]);
  } else {
    shape2Edges += count;
    shape2Names.push([name, count]);
  }
}
const byCountDesc = (a, b) => b[1] - a[1];
shape2Names.sort(byCountDesc);
shape3Names.sort(byCountDesc);

const total = hubEdges.length;
const pct = (n) => (total === 0 ? "0.0" : ((n / total) * 100).toFixed(1));
process.stdout.write(
  `\nentry-hub edges: ${total}\n` +
    `  bare receiver (no constant to narrow with):     ${bare} (${pct(bare)}%)\n` +
    `  non-constant receiver (var / chain / ivar):     ${nonConstant} (${pct(nonConstant)}%)\n` +
    `  constant receiver, class NOT in cg_symbols:     ${shape2Edges} (${pct(shape2Edges)}%)  [shape 2]\n` +
    `  constant receiver, class IS in cg_symbols:      ${shape3Edges} (${pct(shape3Edges)}%)  [shape 3]\n` +
    `  distinct constant receivers: ${constantReceivers.size} (${shape2Names.length} unindexed, ${shape3Names.length} indexed)\n`,
);

const dump = (label, rows) => {
  process.stdout.write(`\n${label} (top ${Math.min(sampleCount, rows.length)}):\n`);
  for (const [name, count] of rows.slice(0, sampleCount))
    process.stdout.write(`  ${count.toString().padStart(5)}  ${name}\n`);
};
dump("shape 3 — indexed concrete entries that still land on the hub", shape3Names);
// The pair is what says WHICH hub a concrete entry collapsed onto — a receiver
// name alone cannot distinguish "narrowing failed" from "the target is a hub
// this receiver genuinely inherits".
dump("constant call → hub target", [...constantPairs.entries()].sort(byCountDesc));
dump("shape 2 — constants whose class is absent from cg_symbols", shape2Names);
if (nonConstantSamples.length > 0) {
  process.stdout.write(`\nnon-constant receiver samples:\n`);
  for (const e of nonConstantSamples) {
    process.stdout.write(`  ${e.call_expression}  →  ${e.target_symbol_id}   (${e.source_rel_path})\n`);
  }
}
