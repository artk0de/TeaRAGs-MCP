/**
 * Python codegraph oracle — the production chain diffed against jedi, call site
 * by call site (bd tea-rags-mcp-xumwz).
 *
 * Same mechanism as `ts-codegraph-typechecker-oracle.ts`, with the ground truth
 * moved out of process: TypeScript has `ts.TypeChecker` in-process, Python has
 * jedi behind `uv`. The walk, the exclusion layers, the diff and the tally are
 * IMPORTED from the TS oracle rather than reimplemented — a second copy of the
 * corpus-selection rules is exactly how the TS harness came to score 1,344
 * generated files it had no business scoring.
 *
 * Usage:
 *   npx tsx scripts/py-codegraph-jedi-oracle.ts --corpus <abs path> \
 *     [--python <interpreter running jedi>] [--environment <corpus venv>] \
 *     [--roots src,server] [--limit N] [--samples N] [--seed N]
 *     [--json out.json] [--quiet]
 *
 * `--corpus` may also be a manifest NAME (`netbox`), in which case the root, the
 * venv interpreter and the source roots come from
 * `scripts/lib/codegraph-corpora.json`.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { extname, join, resolve as resolvePath } from "node:path";
import { createInterface } from "node:readline";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type CallRef,
} from "../src/core/contracts/types/codegraph.js";
import type {
  SymbolResolutionOutcome,
  SymbolResolutionStrategy,
  TypeRef,
} from "../src/core/contracts/types/language.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../src/core/domains/language/index.js";
import { createPythonSymbolResolutionChain } from "../src/core/domains/language/python/resolver/index.js";
import { CONE_MAX_DEFAULT } from "../src/core/domains/language/python/resolver/strategies/index.js";
import { resolveViaChain } from "../src/core/domains/language/resolver-chain.js";
import { CODEGRAPH_LANGUAGES } from "../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { classifyReceiverKind } from "../src/core/domains/trajectory/codegraph/symbols/receiver-kind.js";
import { InMemoryGlobalSymbolTable } from "../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { loadCodegraphCorpora } from "./lib/codegraph-corpora.js";
import {
  applySuperMroBlindSpot,
  categorizePySite,
  classifyPyVerdict,
  isSuperCallSite,
  samplePyRows,
  tallyPyCoverage,
  tallyPyRows,
  type PyOracleRow,
  type PySiteFacts,
  type PyTargetOrigin,
  type PyUnlocatedShape,
} from "./lib/py-oracle-core.js";
import {
  buildCorpusExclusionFilter,
  buildSymbolDefs,
  collectSourceFiles,
  extractFile,
  formatOracleTable,
} from "./ts-codegraph-typechecker-oracle.js";

/**
 * Wrap one pass so the harness learns WHICH pass answered, without touching
 * production. Precedent: `DeferFileOnlyStrategy` in `codegraph-chain-tally.ts`.
 * Every outcome passes through untouched — the probe only records.
 */
export class AnsweredByProbe implements SymbolResolutionStrategy {
  readonly name: string;
  constructor(
    private readonly inner: SymbolResolutionStrategy,
    private readonly record: { answeredBy: string },
  ) {
    this.name = inner.name;
  }

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    const outcome = this.inner.attempt(call, ctx);
    if (outcome.kind === "resolved") this.record.answeredBy = this.inner.name;
    return outcome;
  }
}

/**
 * The Python chain, from the ONE factory `PythonCallResolver` composes with
 * (bd tea-rags-mcp-3yxmy). This used to be a hand-copied array, and it silently
 * lost `importedName` when that pass landed — `chainDrift` 117 on flask, 552 on
 * ugnest, every verdict void. There is nothing left here to keep in sync.
 */
export function buildPythonChain(): SymbolResolutionStrategy[] {
  return createPythonSymbolResolutionChain({
    mode: DEFAULT_AMBIGUOUS_RESOLVE_MODE,
    coneMax: CONE_MAX_DEFAULT,
  });
}

const SCORED_EXTENSION = ".py";

/** Child stderr chunks kept for the failure message. Enough for a uv/jedi traceback. */
const STDERR_TAIL_CHUNKS = 64;

export interface PyChainSite {
  relPath: string;
  call: CallRef;
  ctx: CallContext;
  receiverKind: string;
  chain: { targetRelPath: string; targetSymbolId: string | null } | null;
  answeredBy: string;
  /**
   * The runner's OWN verdict on a declined call, reproduced in the runner's
   * order: `dynamicSend` → `targetsExternalImport` → "no in-project definition
   * for this short name" → `targetsCoreAmbiguousMember`. The plain "external"
   * shorthand skips two branches, and skipping them would attribute
   * `noInProjectDef` sites to the vocabulary that did not claim them.
   */
  missBucket: "resolved" | "dynamicSend" | "external" | "noInProjectDef" | "coreAmbiguous" | "miss";
}

export interface PyCorpusWalk {
  sites: PyChainSite[];
  files: number;
  symbolTableOnlyFiles: number;
  parseFailures: number;
  ingestIgnored: number;
  codegraphExcluded: number;
  chainDrift: number;
}

/**
 * Walk the corpus exactly as production selects files, build ONE symbol table
 * over every `CODEGRAPH_LANGUAGES` extension, then resolve only `.py` call
 * sites. netbox ships JavaScript, and leaving it out of the table would make
 * every call into it look like a resolver miss (the TS harness's `.js` blind
 * spot, same shape, other language).
 */
export async function walkCorpus(corpusRoot: string, limit: number, quiet: boolean): Promise<PyCorpusWalk> {
  const factory = new LanguageFactory();
  const composer = new DefaultSymbolIdComposer();
  const exclude = await buildCorpusExclusionFilter(corpusRoot, factory);
  // Every codegraph extension, not just `.py`: netbox ships JavaScript, and a
  // symbol table missing it turns every call into that code into a phantom
  // resolver miss.
  const selection = await collectSourceFiles(corpusRoot, corpusRoot, exclude, Object.keys(CODEGRAPH_LANGUAGES));

  const symbolTable = new InMemoryGlobalSymbolTable();
  // Run-global, as `CodegraphRunState` merges them at the pass-1→pass-2
  // barrier. `classExtends` was already accumulated here; the type channels
  // ride the same barrier, and the resolver passes that read them — Python's
  // `chainType` reads `structuredReturnTypes` — measure a no-op without them
  // (bd tea-rags-mcp-9fgdi, decision 7).
  const classExtends: Record<string, string> = {};
  const structuredReturnTypes: Record<string, TypeRef> = {};
  const functionReturnTypes: Record<string, string> = {};
  const classAncestors: Record<string, readonly string[]> = {};
  const extractions: {
    relPath: string;
    extraction: NonNullable<ReturnType<typeof extractFile>>;
  }[] = [];
  let parseFailures = 0;
  let symbolTableOnlyFiles = 0;

  for (const relPath of selection.kept.slice(0, limit)) {
    const extraction = extractFile(corpusRoot, relPath, composer, factory);
    if (extraction === null) {
      parseFailures++;
      continue;
    }
    symbolTable.upsertFile(relPath, buildSymbolDefs(extraction));
    Object.assign(classExtends, extraction.classExtends ?? {});
    Object.assign(structuredReturnTypes, extraction.structuredReturnTypes ?? {});
    Object.assign(functionReturnTypes, extraction.functionReturnTypes ?? {});
    Object.assign(classAncestors, extraction.classAncestors ?? {});
    if (extname(relPath) === SCORED_EXTENSION) extractions.push({ relPath, extraction });
    else symbolTableOnlyFiles++;
  }
  if (!quiet) process.stderr.write(`pass 1: ${extractions.length} python files, ${symbolTable.size()} symbols\n`);

  const production = factory.create("python").resolver;
  if (production === undefined) throw new Error("the python language provider has no resolver");
  const sites: PyChainSite[] = [];
  let chainDrift = 0;
  // ONE chain for the whole walk, wrapping ONE record the loop resets — the
  // chain now owns a `PythonImportFileMapper` whose memo is per-instance, and
  // rebuilding it per call site would both throw that cache away every site and
  // stop mirroring how production shares a single mapper.
  const probe = { answeredBy: "none" };
  const probedChain = buildPythonChain().map((pass) => new AnsweredByProbe(pass, probe));

  for (const { relPath, extraction } of extractions) {
    for (const chunk of extraction.chunks) {
      const ctx: CallContext = {
        callerFile: relPath,
        callerScope: chunk.scope,
        callerSymbolId: chunk.symbolId,
        imports: extraction.imports,
        symbolTable,
        classFieldTypes: extraction.classFieldTypes,
        localBindings: chunk.localBindings,
        classExtends,
        structuredReturnTypes,
        functionReturnTypes,
        classAncestors,
      };
      for (const call of chunk.calls ?? []) {
        if (call.dispatch !== undefined) continue; // the runner skips normal resolution here
        probe.answeredBy = "none";
        const chain = resolveViaChain(probedChain, call, ctx);
        const truth = production.resolve(call, ctx);
        const same =
          (chain === null && truth === null) ||
          (chain !== null &&
            truth !== null &&
            chain.targetRelPath === truth.targetRelPath &&
            chain.targetSymbolId === truth.targetSymbolId);
        if (!same) chainDrift++;
        sites.push({
          relPath,
          call,
          ctx,
          receiverKind: classifyReceiverKind(call, chunk.localBindings),
          chain:
            chain === null
              ? null
              : {
                  targetRelPath: chain.targetRelPath,
                  targetSymbolId: chain.targetSymbolId,
                },
          answeredBy: probe.answeredBy,
          missBucket:
            chain !== null
              ? "resolved"
              : call.dynamicSend === true
                ? "dynamicSend"
                : (production.targetsExternalImport?.(call, ctx) ?? false)
                  ? "external"
                  : symbolTable.lookupByShortName(call.member).length === 0
                    ? "noInProjectDef"
                    : (production.targetsCoreAmbiguousMember?.(call, ctx) ?? false)
                      ? "coreAmbiguous"
                      : "miss",
        });
      }
    }
  }

  return {
    sites,
    files: extractions.length,
    symbolTableOnlyFiles,
    parseFailures,
    ingestIgnored: selection.ingestIgnored,
    codegraphExcluded: selection.codegraphExcluded,
    chainDrift,
  };
}

export interface PyOracleAnswer {
  startLine: number;
  member: string;
  outcome: {
    kind: "inProject" | "external" | "unknown" | "parseFailed";
    origin?: PyTargetOrigin;
    targets?: {
      relPath: string;
      symbolId: string | null;
      pinUncertain: boolean;
    }[];
  };
  siteFacts?: PySiteFacts;
  unlocated?: PyUnlocatedShape;
}

export interface PyOracleFileReply {
  relPath: string;
  parseFailed: boolean;
  parsoErrors: number;
  answers: PyOracleAnswer[];
}

/**
 * The hash seed every oracle child runs under (bd tea-rags-mcp-vua9f).
 *
 * jedi's answer is NOT a pure function of the corpus. Three polar runs of the
 * same chain against the same oracle code scored 14,947 / 14,984 / 10,482 sites
 * `match`, with thousands of rows flipping between `external` and `inProject`
 * in between: hash randomization reorders the set iteration inside jedi's
 * import search, and a corpus owning two packages of one name — polar's
 * `server/polar`, its `sdk/python/polar` and the venv's installed `polar` —
 * gets a different winner per run. Measured directly on
 * `sdk/python/polar/v2026_04/services/benefits.py:111`: seeds 0 and 1 answer
 * site-packages, seeds 2 and 3 answer the repo. Pinning it made two full polar
 * runs byte-identical, 0 rows gained and 0 lost.
 *
 * The VALUE is arbitrary and only has to be fixed. What it must never be is
 * absent: a baseline nobody can reproduce is not a baseline.
 */
export const ORACLE_PYTHON_HASH_SEED = "0";

/**
 * Ask the Python side about every site, one spawn per corpus.
 *
 * NDJSON over pipes rather than a temp file: the input for polar is ~30 MB and
 * a temp file would need cleanup on every failure path. The child never sees
 * the chain's answer — only `(relPath, startLine, callText, receiver, member)`
 * — so it cannot be tuned toward agreement.
 */
export async function askOracle(
  sites: readonly PyChainSite[],
  options: {
    corpusRoot: string;
    python: string[];
    venvPython: string | null;
    /** Absolute source roots jedi must search BEFORE the corpus venv (7dsyq). */
    roots: readonly string[];
    workers: number;
  },
): Promise<Map<string, PyOracleFileReply>> {
  const byFile = new Map<string, PyChainSite[]>();
  for (const site of sites) {
    const bucket = byFile.get(site.relPath);
    if (bucket) bucket.push(site);
    else byFile.set(site.relPath, [site]);
  }

  const [command, ...args] = options.python;
  if (command === undefined) throw new Error("no interpreter command to spawn");
  const child = spawn(command, args, {
    // `pipe`, not `inherit`: the child's stderr is mirrored live so a long run
    // still shows uv/jedi progress, AND tailed so a launcher that dies during
    // the handshake can be REPORTED. With `inherit` the only symptom of a dead
    // child was an unhandled `write EPIPE` from the loop below (3yxmy).
    stdio: ["pipe", "pipe", "pipe"],
    // Merged OVER `process.env` so uv keeps PATH, HOME and its own cache.
    env: { ...process.env, PYTHONHASHSEED: ORACLE_PYTHON_HASH_SEED },
  });
  const stderrTail: string[] = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (piece: string) => {
    process.stderr.write(piece);
    stderrTail.push(piece);
    if (stderrTail.length > STDERR_TAIL_CHUNKS) stderrTail.shift();
  });
  const fail = (reason: string): Error =>
    new Error([`${options.python.join(" ")}`, reason, stderrTail.join("").trimEnd()].filter(Boolean).join("\n"));

  const replies = new Map<string, PyOracleFileReply>();
  const reader = createInterface({ input: child.stdout });
  /** Set once the child is gone, so the write loop stops instead of EPIPE-ing per line. */
  let dead: Error | null = null;
  const done = new Promise<void>((resolveDone, rejectDone) => {
    const die = (error: Error): void => {
      dead ??= error;
      rejectDone(dead);
    };
    reader.on("line", (line) => {
      if (line.trim() === "") return;
      const reply = JSON.parse(line) as PyOracleFileReply;
      replies.set(reply.relPath, reply);
    });
    child.on("error", (error) => {
      die(fail(`could not spawn the oracle: ${error.message}`));
    });
    // A launcher that cannot provision the interpreter dies BEFORE reading the
    // config line, and every subsequent write lands on a closed pipe.
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      die(fail(`the oracle closed its stdin (${error.code ?? error.message}) — it exited before reading the input`));
    });
    child.on("close", (code) => {
      if (code === 0 && dead === null) resolveDone();
      else die(fail(`jedi_oracle.py exited ${String(code)}`));
    });
  });

  child.stdin.write(
    `${JSON.stringify({
      kind: "config",
      corpusRoot: options.corpusRoot,
      venvPython: options.venvPython,
      roots: [...options.roots],
      workers: options.workers,
    })}\n`,
  );
  for (const relPath of [...byFile.keys()].sort()) {
    if (dead !== null) break;
    const batch = (byFile.get(relPath) ?? []).map((site) => ({
      startLine: site.call.startLine,
      callText: site.call.callText,
      receiver: site.call.receiver,
      member: site.call.member,
    }));
    child.stdin.write(`${JSON.stringify({ kind: "file", relPath, sites: batch })}\n`);
  }
  if (dead === null) child.stdin.end();
  await done;
  return replies;
}

/** Join the two answers into scored rows. Pure given its inputs. */
export function buildRows(sites: readonly PyChainSite[], replies: Map<string, PyOracleFileReply>): PyOracleRow[] {
  const rows: PyOracleRow[] = [];
  const cursor = new Map<string, number>();
  for (const site of sites) {
    const reply = replies.get(site.relPath);
    const index = cursor.get(site.relPath) ?? 0;
    cursor.set(site.relPath, index + 1);
    const answer = reply?.answers[index];
    const targets = answer?.outcome.targets ?? [];
    const reported =
      answer === undefined || answer.outcome.kind === "unknown" || answer.outcome.kind === "parseFailed"
        ? ({ kind: "unknown" } as const)
        : answer.outcome.kind === "external"
          ? ({ kind: "external" } as const)
          : ({
              kind: "inProject",
              answer: {
                targetRelPath: targets[0]?.relPath ?? "",
                // A `pinUncertain` target compares at FILE granularity only —
                // matching a null symbol id here degrades the verdict to
                // `fileOnly` rather than manufacturing a `wrongFile`.
                targetSymbolId:
                  targets[0]?.pinUncertain === true
                    ? (site.chain?.targetSymbolId ?? null)
                    : (targets[0]?.symbolId ?? null),
              },
            } as const);
    // jedi walks `super()` through the first base only, so a typeshed answer on
    // a `super()` site is not ground truth. The core withdraws it.
    const { oracle, categories } = applySuperMroBlindSpot({
      isSuperCall: isSuperCallSite({
        receiverKind: site.receiverKind,
        receiver: site.call.receiver,
        facts: answer?.siteFacts,
      }),
      origin: answer?.outcome.origin,
      oracle: reported,
      categories: categorizePySite(answer?.siteFacts, {
        receiver: site.call.receiver,
        member: site.call.member,
      }),
    });
    rows.push({
      relPath: site.relPath,
      startLine: site.call.startLine,
      callText: site.call.callText,
      receiver: site.call.receiver,
      member: site.call.member,
      receiverKind: site.receiverKind,
      categories,
      verdict: classifyPyVerdict({
        chain: site.chain,
        oracle,
        parseFailed: reply?.parseFailed === true,
        classifiedExternal: site.missBucket === "external" || site.missBucket === "coreAmbiguous",
      }),
      answeredBy: site.answeredBy,
      chainOutput: site.chain === null ? "none" : site.chain.targetSymbolId === null ? "fileOnly" : "pinned",
      chain: site.chain ?? undefined,
      origin: answer?.outcome.origin,
      oracleDegraded: (reply?.parsoErrors ?? 0) > 0,
      unlocatedShape: answer?.unlocated,
    });
  }
  return rows;
}

export interface PyOracleCliOptions {
  corpusRoot: string;
  corpusName: string;
  venvPython: string | null;
  /** Absolute, manifest order — see `resolveCorpusRoots`. Never empty. */
  roots: string[];
  pythonArgv: string[];
  limit: number;
  samples: number;
  seed: number;
  workers: number;
  json: string | null;
  quiet: boolean;
}

/**
 * The interpreter `uv run` starts for jedi itself, DERIVED. A manifest entry
 * declares its launcher outright in `oraclePython` and that wins; this is what
 * an undeclared corpus falls back to.
 *
 * A corpus's `requiresPython` is the floor its own SYNTAX needs — polar's 3.14
 * is why the oracle reads its `match` statements at all — so it is a lower
 * bound on the grammar and never the version that runs jedi. The oracle's own
 * environment is pinned `>=3.13` (`scripts/py-oracle/pyproject.toml`), and a
 * corpus declaring 3.9 (httpx) or 3.10 (flask) would otherwise resolve to an
 * interpreter jedi 0.20.0 refuses to install on, failing the whole run.
 */
const ORACLE_PYTHON_FLOOR = "3.13";

export function liftToOracleFloor(corpusFloor: string | undefined): string {
  if (corpusFloor === undefined) return ORACLE_PYTHON_FLOOR;
  const parts = (version: string): number[] => version.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const [corpus, floor] = [parts(corpusFloor), parts(ORACLE_PYTHON_FLOOR)];
  for (let i = 0; i < Math.max(corpus.length, floor.length); i++) {
    const [left, right] = [corpus[i] ?? 0, floor[i] ?? 0];
    if (left !== right) return left > right ? corpusFloor : ORACLE_PYTHON_FLOOR;
  }
  return ORACLE_PYTHON_FLOOR;
}

/**
 * The corpus's own source roots, absolute, in the order jedi must search them.
 *
 * A manifest declares them relative to the corpus (`server`, `src`, `.`); jedi
 * needs absolute entries, and it needs them AHEAD of the corpus venv, or an
 * installed distribution that happens to share a top-level module name with the
 * corpus wins the lookup — which is what put 1,610 correct polar rows in the
 * phantom bucket (7dsyq). A corpus the manifest does not describe falls back to
 * the root itself, which is what jedi would have searched anyway.
 */
export function resolveCorpusRoots(
  override: string | undefined,
  declared: readonly string[] | undefined,
  corpusRoot: string,
): string[] {
  const source = override === undefined ? (declared ?? []) : override.split(",");
  const entries = source.map((entry) => entry.trim()).filter((entry) => entry !== "");
  if (entries.length === 0) return [resolvePath(corpusRoot)];
  return entries.map((entry) => resolvePath(corpusRoot, entry));
}

export function parseArgs(argv: readonly string[]): PyOracleCliOptions {
  const read = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const corpusArg = read("--corpus") ?? process.cwd();
  const manifest = loadCodegraphCorpora()[corpusArg];
  // `oraclePython` is the DECLARED launcher and wins: `requiresPython` says what
  // the corpus needs to run ITSELF, and deriving the launcher from httpx's
  // `>=3.9` is what killed the host mid-handshake (3yxmy). `liftToOracleFloor`
  // stays as the derivation for a corpus the manifest does not declare.
  const interpreter =
    read("--python") ?? manifest?.oraclePython ?? liftToOracleFloor(manifest?.requiresPython.replace(">=", ""));
  const corpusRoot = manifest ? manifest.path : resolvePath(corpusArg);
  return {
    corpusRoot,
    corpusName: manifest?.name ?? corpusArg,
    venvPython: read("--environment") ?? manifest?.venvPython ?? null,
    roots: resolveCorpusRoots(read("--roots"), manifest?.roots, corpusRoot),
    // `uv run --no-project` keeps jedi's environment out of the corpus's, which
    // is what lets one oracle build serve three interpreter versions.
    pythonArgv: [
      "uv",
      "run",
      "--no-project",
      "--python",
      interpreter,
      "--with",
      "jedi==0.20.0",
      "python",
      join(import.meta.dirname, "py-oracle", "jedi_oracle.py"),
    ],
    limit: Number(read("--limit") ?? Number.MAX_SAFE_INTEGER),
    samples: Number(read("--samples") ?? 25),
    seed: Number(read("--seed") ?? 20260908),
    workers: Number(read("--workers") ?? 8),
    json: read("--json") ?? null,
    quiet: argv.includes("--quiet"),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const walk = await walkCorpus(options.corpusRoot, options.limit, options.quiet);
  const replies = await askOracle(walk.sites, {
    corpusRoot: options.corpusRoot,
    python: options.pythonArgv,
    venvPython: options.venvPython,
    roots: options.roots,
    workers: options.workers,
  });
  const rows = buildRows(walk.sites, replies);

  const byReceiver = tallyPyRows(rows, (row) => [row.receiverKind]);
  const byAnsweredBy = tallyPyRows(rows, (row) => [row.answeredBy]);
  const byCategory = tallyPyRows(rows, (row) => row.categories);
  const coverage = tallyPyCoverage(rows);
  const degraded = rows.filter((row) => row.oracleDegraded).length;
  const unknown = rows.filter((row) => row.verdict === "chainOnly" || row.verdict === "bothUnresolved").length;
  const covered = rows.length - unknown;
  const chainOutput = {
    edges: rows.filter((row) => row.chainOutput !== "none").length,
    fileOnly: rows.filter((row) => row.chainOutput === "fileOnly").length,
    unresolved: rows.filter((row) => row.chainOutput === "none").length,
  };

  const out = [
    "",
    `Python codegraph jedi oracle — ${options.corpusName} @ ${options.corpusRoot}`,
    `files ${walk.files} scored (+${walk.symbolTableOnlyFiles} in the symbol table, parse failures ${walk.parseFailures})`,
    `excluded as production excludes them: ${walk.ingestIgnored} by .gitignore and friends · ${walk.codegraphExcluded} generated/test/non-app`,
    `call sites ${rows.length} · chain drift ${walk.chainDrift}${walk.chainDrift === 0 ? "" : "  <- REBUILD IS STALE, numbers void"}`,
    `chain output: ${chainOutput.edges} edges (${chainOutput.fileOnly} file-only) · ${chainOutput.unresolved} unresolved`,
    `ground truth ${covered}/${rows.length} (${((covered / Math.max(rows.length, 1)) * 100).toFixed(1)}%) · oracleDegraded ${degraded} · parseFailed ${coverage.parseFailed}`,
    `skippedInProject ${coverage.skippedInProject} · unlocated ${coverage.unlocated} (${Object.entries(
      coverage.unlocatedByShape,
    )
      .map(([shape, count]) => `${shape} ${String(count)}`)
      .join(", ")})`,
    `elapsed ${((Date.now() - started) / 1000).toFixed(1)}s`,
    "",
    formatOracleTable("BY RECEIVER KIND (partition — each call site counted once)", byReceiver),
    "",
    formatOracleTable("BY ANSWERING PASS (partition — 'none' is the declined set)", byAnsweredBy),
    "",
    formatOracleTable("BY MISSED-SHAPE CATEGORY (rows overlap — a site can carry several)", byCategory),
    "",
  ];
  process.stdout.write(out.join("\n"));

  if (options.json !== null) {
    const payload = {
      corpus: options.corpusName,
      corpusRoot: options.corpusRoot,
      seed: options.seed,
      // The sampling seed above reproduces the SAMPLE; this one reproduces the
      // ANSWERS, and a report carrying only the first would be reproducible in
      // its rows and not in its numbers (vua9f).
      pythonHashSeed: ORACLE_PYTHON_HASH_SEED,
      counters: {
        files: walk.files,
        symbolTableOnlyFiles: walk.symbolTableOnlyFiles,
        parseFailures: walk.parseFailures,
        ingestIgnored: walk.ingestIgnored,
        codegraphExcluded: walk.codegraphExcluded,
        chainDrift: walk.chainDrift,
        callSites: rows.length,
        groundTruth: covered,
        oracleDegraded: degraded,
        skippedInProject: coverage.skippedInProject,
        parseFailed: coverage.parseFailed,
        unlocated: coverage.unlocated,
        unlocatedByShape: coverage.unlocatedByShape,
        chainOutput,
      },
      byReceiver,
      byAnsweredBy,
      byCategory,
      samples: Object.fromEntries(
        (["missed", "wrongFile", "phantom", "skippedInProject"] as const).map((verdict) => [
          verdict,
          samplePyRows(rows, verdict, options.samples, options.seed),
        ]),
      ),
    };
    writeFileSync(options.json, `${JSON.stringify(payload, null, 2)}\n`);
    process.stderr.write(`wrote ${options.json}\n`);
  }
  if (walk.chainDrift !== 0) process.exitCode = 1;
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
}
