/**
 * What an INCREMENTAL codegraph run still loses on a Ruby corpus, per receiver
 * kind, with no index run at all (bd tea-rags-mcp-8qyax).
 *
 * The defect class: `GlobalSymbolTable` hydrates from `cg_symbols` when the
 * collection opens, so DEFINITION lookups are project-wide on every run, while
 * `CodegraphRunState`'s run-global maps are built in `absorb` from the files the
 * CURRENT batch walked. bd znxg8 closed that gap for the ancestry and
 * self-dispatch families by persisting them (`cg_pass1_aggregates`, migration
 * 021) and hydrating them at the barrier. The TYPE-INFERENCE family —
 * `structuredReturnTypes`, `ivarTypes`, `instantiatedTypes`, `dispatchTables`,
 * `callbackParams`, `paramNames`, `classField*` — was left batch-scoped on
 * purpose: those are per-METHOD, so persisting them grows the slice from
 * "proportional to classes" to "proportional to methods", and nothing in the
 * znxg8 field report implicated them.
 *
 * This measures what that costs before anyone pays the row size for it. Both
 * sides walk the SAME working tree and resolve the SAME files against the SAME
 * project-wide symbol table; the only difference is which run-global maps the
 * barrier had:
 *
 *   FULL — every file absorbed, so every map is complete (the reference).
 *   INC  — only the batch absorbed, then `seal` hydrates the persisted pass-1
 *          slices for every OTHER file, exactly as production does.
 *
 * So the per-kind delta is attributable to the maps hydration does NOT carry.
 * A delta inside the noise floor closes the bead; a delta concentrated in one
 * receiver kind names the map worth persisting.
 *
 * Batches are contiguous slices at evenly spaced offsets rather than a random
 * sample: a real incremental run carries whatever files a commit touched, and
 * neighbouring files in a Rails tree share a namespace — a uniform random pick
 * would under-represent exactly the intra-namespace resolution this is about.
 *
 * Usage:
 *   npx tsx scripts/spikes/ruby-incremental-runglobal-delta.ts \
 *     --corpus /abs/path/to/repo [--batches 4] [--batch-size 40] [--limit N] [--json out.json]
 */
import { writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import type { CodegraphPass1FileAggregates } from "../../src/core/contracts/types/codegraph-pass1.js";
import type { FileExtraction, RelPath } from "../../src/core/contracts/types/codegraph.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../src/core/domains/language/index.js";
import { buildPass1Aggregates } from "../../src/core/domains/trajectory/codegraph/symbols/pass1-aggregates.js";
import {
  RECEIVER_KINDS,
  type ReceiverKind,
} from "../../src/core/domains/trajectory/codegraph/symbols/receiver-kind.js";
import { CallEdgeResolutionRunner } from "../../src/core/domains/trajectory/codegraph/symbols/resolution-runner.js";
import { CodegraphRunState, languageKindTally } from "../../src/core/domains/trajectory/codegraph/symbols/run-state.js";
import { extractSelfDispatchMethods } from "../../src/core/domains/trajectory/codegraph/symbols/self-dispatch-discovery.js";
import { InMemoryGlobalSymbolTable } from "../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import {
  buildCorpusExclusionFilter,
  buildSymbolDefs,
  collectSourceFiles,
  extractFile,
} from "../ts-codegraph-typechecker-oracle.js";

const RUBY_EXTENSIONS: readonly string[] = [".rb"];

/** The four numbers a receiver-kind bucket is compared on. */
interface KindSlice {
  attempted: number;
  resolved: number;
  externalSkipped: number;
  unnarrowedTemplate: number;
}

const emptySlice = (): KindSlice => ({ attempted: 0, resolved: 0, externalSkipped: 0, unnarrowedTemplate: 0 });

/**
 * Snapshot the ruby per-kind tally. Taken BEFORE and AFTER each batch and
 * subtracted, because `CodegraphRunState.stats` accumulates across every
 * `resolve` a runner performs and the FULL side reuses one sealed state for
 * every batch — re-sealing per batch would re-run the discovery over the whole
 * corpus for no gain.
 */
function snapshotKinds(state: CodegraphRunState): Record<ReceiverKind, KindSlice> {
  const tally = languageKindTally(state.stats, "ruby");
  const out = {} as Record<ReceiverKind, KindSlice>;
  for (const kind of RECEIVER_KINDS) {
    const t = tally[kind];
    out[kind] = {
      attempted: t.attempted,
      resolved: t.resolved,
      externalSkipped: t.externalSkipped,
      unnarrowedTemplate: t.unnarrowedTemplate,
    };
  }
  return out;
}

function subtractKinds(
  after: Record<ReceiverKind, KindSlice>,
  before: Record<ReceiverKind, KindSlice>,
): Record<ReceiverKind, KindSlice> {
  const out = {} as Record<ReceiverKind, KindSlice>;
  for (const kind of RECEIVER_KINDS) {
    out[kind] = {
      attempted: after[kind].attempted - before[kind].attempted,
      resolved: after[kind].resolved - before[kind].resolved,
      externalSkipped: after[kind].externalSkipped - before[kind].externalSkipped,
      unnarrowedTemplate: after[kind].unnarrowedTemplate - before[kind].unnarrowedTemplate,
    };
  }
  return out;
}

function addInto(target: Record<ReceiverKind, KindSlice>, delta: Record<ReceiverKind, KindSlice>): void {
  for (const kind of RECEIVER_KINDS) {
    target[kind].attempted += delta[kind].attempted;
    target[kind].resolved += delta[kind].resolved;
    target[kind].externalSkipped += delta[kind].externalSkipped;
    target[kind].unnarrowedTemplate += delta[kind].unnarrowedTemplate;
  }
}

const emptyKinds = (): Record<ReceiverKind, KindSlice> => {
  const out = {} as Record<ReceiverKind, KindSlice>;
  for (const kind of RECEIVER_KINDS) out[kind] = emptySlice();
  return out;
};

/** `resolved / max(1, attempted − externalSkipped)` — the same shape as the persisted rate. */
const rate = (s: KindSlice): number => s.resolved / Math.max(1, s.attempted - s.externalSkipped);

/**
 * Which family of run-global maps to hand the incremental side, on top of what
 * hydration already carries. This is the ABLATION: hydration cannot supply these
 * today, so copying one family from the full run answers "what would persisting
 * exactly this recover?" without first building the persistence.
 *
 * `types` and `params` are grouped rather than split per map because they are
 * produced together by the walker's type-source chain — persisting one without
 * the other is not a shipping option, so measuring them apart would name a fix
 * nobody could take.
 */
const ABLATIONS = ["none", "types", "sret", "fret", "ivar", "rta", "dispatch", "params", "all"] as const;
type Ablation = (typeof ABLATIONS)[number];

/**
 * Overlay `full`'s maps onto `inc` for the chosen family. Run AFTER `seal`,
 * because seal DERIVES `paramTypes` / `derivedClassFieldTypes` from the raw
 * channels and would overwrite anything written before it.
 */
function ablate(inc: CodegraphRunState, full: CodegraphRunState, which: Ablation): void {
  const wants = (family: Ablation): boolean => which === "all" || which === family;
  // `types` is the coarse family; `sret` and `ivar` split it, because the two
  // halves cost very different amounts to persist — `structuredReturnTypes` is
  // keyed per METHOD (the row-size objection this bead exists to weigh), while
  // `ivarTypes` is keyed per CLASS, the same granularity the existing pass-1
  // slice already carries.
  if (wants("types") || wants("sret")) {
    Object.assign(inc.structuredReturnTypes, full.structuredReturnTypes);
  }
  if (wants("types") || wants("fret")) {
    Object.assign(inc.returnTypes, full.returnTypes);
  }
  if (wants("types") || wants("ivar")) {
    Object.assign(inc.ivarTypes, full.ivarTypes);
  }
  if (wants("rta")) {
    for (const t of full.instantiatedTypes) inc.instantiatedTypes.add(t);
  }
  if (wants("dispatch")) {
    Object.assign(inc.dispatchTables, full.dispatchTables);
    Object.assign(inc.callbackParams, full.callbackParams);
  }
  if (wants("params")) {
    Object.assign(inc.paramNames, full.paramNames);
    Object.assign(inc.paramTypes, full.paramTypes);
    Object.assign(inc.classFieldParamLinks, full.classFieldParamLinks);
    Object.assign(inc.derivedClassFieldTypes, full.derivedClassFieldTypes);
  }
}

function flag(name: string, fallback: string | undefined): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

async function main(): Promise<void> {
  const corpus = flag("--corpus", undefined);
  if (corpus === undefined) {
    process.stderr.write("--corpus <abs path> is required\n");
    process.exit(1);
  }
  const root = resolvePath(corpus);
  const batches = Number(flag("--batches", "4"));
  const batchSize = Number(flag("--batch-size", "40"));
  const limit = Number(flag("--limit", String(Number.MAX_SAFE_INTEGER)));
  const jsonOut = flag("--json", undefined);
  const ablation = (flag("--ablate", "none") ?? "none") as Ablation;
  if (!ABLATIONS.includes(ablation)) {
    process.stderr.write(`--ablate must be one of ${ABLATIONS.join(", ")}\n`);
    process.exit(1);
  }

  const factory = new LanguageFactory();
  const composer = new DefaultSymbolIdComposer();
  const selection = await collectSourceFiles(
    root,
    root,
    await buildCorpusExclusionFilter(root, factory),
    RUBY_EXTENSIONS,
  );
  const files = selection.kept.slice(0, limit);
  process.stdout.write(
    `corpus ${root}\n  ${files.length} ruby files kept ` +
      `(${selection.ingestIgnored} ingest-ignored, ${selection.codegraphExcluded} codegraph-excluded)\n`,
  );

  // ── Phase 1: full walk. Symbol table + full run-global state + the pass-1
  //    slices an incremental run would read back. Extractions are discarded as
  //    we go; the batch files are re-extracted below (cheap, and it keeps peak
  //    memory proportional to the corpus's SYMBOLS, not its ASTs).
  const symbolTable = new InMemoryGlobalSymbolTable();
  const fullState = new CodegraphRunState();
  fullState.bindProjectRoot(root);
  fullState.loadGemfile(root);
  const slices: CodegraphPass1FileAggregates[] = [];
  let walked = 0;
  let parseFailures = 0;
  for (const relPath of files) {
    const extraction = extractFile(root, relPath, composer, factory);
    if (extraction === null) {
      parseFailures += 1;
      continue;
    }
    symbolTable.upsertFile(relPath, buildSymbolDefs(extraction));
    const selfDispatch = extractSelfDispatchMethods(extraction.chunks);
    fullState.absorb(extraction, selfDispatch);
    const slice = buildPass1Aggregates(extraction, selfDispatch);
    if (slice !== undefined) slices.push(slice);
    walked += 1;
  }
  await fullState.seal(async () => symbolTable);
  process.stdout.write(
    `walked ${walked} (${parseFailures} unparseable) · pass-1 slices ${slices.length} · ` +
      `self-dispatch methods ${fullState.selfDispatchMethods.length} · templates ${Object.keys(fullState.selfDispatchTemplates).length}\n`,
  );
  // The COST side of the trade-off this bead weighs: how many entries each
  // candidate map would add to the persisted slice, against the ancestry keys
  // it already carries. A per-METHOD map is the objection; these are the
  // numbers that say how big it actually is on a real corpus.
  process.stdout.write(
    `run-global map sizes — structuredReturnTypes ${Object.keys(fullState.structuredReturnTypes).length} (per method) · ` +
      `returnTypes ${Object.keys(fullState.returnTypes).length} (per function name) · ` +
      `ivarTypes ${Object.keys(fullState.ivarTypes).length} (per class) · ` +
      `ancestors ${Object.keys(fullState.ancestors).length} (per class, already persisted)\n`,
  );

  // ── Phase 2: batches — contiguous windows at evenly spaced offsets.
  const stride = Math.max(1, Math.floor(files.length / batches));
  const windows: RelPath[][] = [];
  for (let b = 0; b < batches; b++) {
    const start = Math.min(b * stride, Math.max(0, files.length - batchSize));
    windows.push(files.slice(start, start + batchSize));
  }

  const fullTotals = emptyKinds();
  const incTotals = emptyKinds();
  const fullRunner = new CallEdgeResolutionRunner(factory, fullState);

  for (const [i, window] of windows.entries()) {
    const extractions: FileExtraction[] = [];
    for (const relPath of window) {
      const e = extractFile(root, relPath, composer, factory);
      if (e !== null) extractions.push(e);
    }

    // FULL side — resolve against the state that absorbed every file.
    const before = snapshotKinds(fullState);
    for (const e of extractions) fullRunner.resolve(e, symbolTable);
    addInto(fullTotals, subtractKinds(snapshotKinds(fullState), before));

    // INC side — a fresh run that walked ONLY this window, with the rest
    // hydrated from the persisted slices exactly as production does.
    const incState = new CodegraphRunState();
    incState.bindProjectRoot(root);
    incState.loadGemfile(root);
    for (const e of extractions) incState.absorb(e, extractSelfDispatchMethods(e.chunks));
    await incState.seal(
      async () => symbolTable,
      async () => slices,
    );
    ablate(incState, fullState, ablation);
    const incRunner = new CallEdgeResolutionRunner(factory, incState);
    for (const e of extractions) incRunner.resolve(e, symbolTable);
    addInto(incTotals, snapshotKinds(incState));

    process.stdout.write(`  batch ${i + 1}/${windows.length}: ${extractions.length} files\n`);
  }

  // ── Report.
  const rows: string[] = [];
  let attemptedAll = 0;
  let lostAll = 0;
  for (const kind of RECEIVER_KINDS) {
    const f = fullTotals[kind];
    const n = incTotals[kind];
    if (f.attempted === 0 && n.attempted === 0) continue;
    attemptedAll += f.attempted;
    lostAll += f.resolved - n.resolved;
    rows.push(
      `  ${kind.padEnd(11)} attempted ${String(f.attempted).padStart(6)}` +
        `  full ${rate(f).toFixed(4)} ${String(f.resolved).padStart(6)}` +
        `  inc ${rate(n).toFixed(4)} ${String(n.resolved).padStart(6)}` +
        `  Δresolved ${(n.resolved - f.resolved).toString().padStart(5)}${
          f.unnarrowedTemplate !== n.unnarrowedTemplate
            ? `  Δunnarrowed ${(n.unnarrowedTemplate - f.unnarrowedTemplate).toString().padStart(4)}`
            : ""
        }`,
    );
  }
  process.stdout.write(
    `\nper receiver kind — FULL (every file absorbed) vs INC (batch + hydrated pass-1 slices` +
      `${ablation === "none" ? "" : ` + ablated ${ablation}`})\n${rows.join("\n")}\n` +
      `\ntotal: ${attemptedAll} calls attempted across ${windows.length} batches · ` +
      `${lostAll} edge(s) lost by the incremental run ` +
      `(${attemptedAll === 0 ? "0.00" : ((lostAll / attemptedAll) * 100).toFixed(2)}% of attempts)\n`,
  );

  if (jsonOut !== undefined) {
    writeFileSync(
      jsonOut,
      JSON.stringify(
        { corpus: root, files: files.length, windows: windows.map((w) => w.length), fullTotals, incTotals },
        null,
        2,
      ),
    );
    process.stdout.write(`wrote ${jsonOut}\n`);
  }
}

await main();
