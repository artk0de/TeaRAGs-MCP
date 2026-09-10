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
 *     [--oracle jedi|lsp|merged] [--json out.json] [--quiet]
 *
 * `--oracle jedi` is the default and is byte-identical to every published
 * number. `merged` repairs the files parso 0.8.7 cannot read with a second
 * engine, per file (bd tea-rags-mcp-w205u); the report then carries BOTH
 * denominators and never one alone.
 *
 * `--corpus` may also be a manifest NAME (`netbox`), in which case the root, the
 * venv interpreter and the source roots come from
 * `scripts/lib/codegraph-corpora.json`.
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { extname, join, resolve as resolvePath } from "node:path";
import { createInterface } from "node:readline";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type CallRef,
  type ModuleReexport,
} from "../src/core/contracts/types/codegraph.js";
import type {
  SymbolResolutionOutcome,
  SymbolResolutionStrategy,
  TypeRef,
} from "../src/core/contracts/types/language.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../src/core/domains/language/index.js";
import { createPythonSymbolResolutionChain } from "../src/core/domains/language/python/resolver/index.js";
import { CONE_MAX_DEFAULT } from "../src/core/domains/language/python/resolver/strategies/index.js";
import { pythonEnclosingClass } from "../src/core/domains/language/python/resolver/strategies/shared.js";
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
  legacyViewOf,
  locateCalleeColumn,
  mergeOracleReplies,
  oracleEntryOf,
  samplePyRows,
  tallyPyCoverage,
  tallyPyRecall,
  tallyPyRows,
  type MergedOracleFileReply,
  type OracleEngine,
  type OracleSelection,
  type PyOracleFileReply,
  type PyOracleRow,
  type PyRecallSplit,
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
  // `<relPath>::<class FQ>` → field → type — the run-global field address the
  // MRO fold reads a base class's fields from (bd tea-rags-mcp-f0xaa).
  const classFieldTypesByClassKey: Record<string, Record<string, string>> = {};
  // `relPath` → the names its `from` statements bind — what lets the import
  // mapper walk past a package that re-exports rather than declares (xpl83.3).
  const moduleReexports: Record<string, readonly ModuleReexport[]> = {};
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
    for (const [classKey, fields] of Object.entries(extraction.classFieldTypesByClassKey ?? {})) {
      classFieldTypesByClassKey[classKey] = { ...classFieldTypesByClassKey[classKey], ...fields };
    }
    if (extraction.moduleReexports) moduleReexports[relPath] = extraction.moduleReexports;
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
        callResultBindings: chunk.callResultBindings,
        classExtends,
        structuredReturnTypes,
        functionReturnTypes,
        classAncestors,
        classFieldTypesByClassKey,
        moduleReexports,
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

/**
 * The reply schema moved to the pure core in E4.0.2: it is the CONTRACT two
 * engines speak, not something the jedi host owns. Re-exported here so every
 * existing importer — the scratch row drivers included — keeps its path.
 */
export type { PyOracleAnswer, PyOracleFileReply } from "./lib/py-oracle-core.js";

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
    /**
     * Absolute source roots jedi must search BEFORE the corpus venv (7dsyq).
     * The Python side reorders them PER FILE — the root containing the file
     * leads — so this order only decides files under none of them (vua9f).
     */
    roots: readonly string[];
    workers: number;
    /**
     * The corpus's `oraclePython`, for an engine that configures its grammar
     * per workspace (pyright's `python.analysis.pythonVersion`). OMITTED from
     * the config line when absent, so jedi's record stays byte-identical.
     */
    pythonVersion?: string;
    /**
     * Attach a 0-based `column` for the callee to every site record. Off for
     * jedi, which locates the node in its own AST; ON for an engine queried by
     * POSITION, because `CallRef` carries no column and letting the engine
     * re-derive one biases it toward the leftmost same-named callee (D7).
     */
    columns?: boolean;
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
      // `undefined` drops the key, which is why jedi's config line is unchanged.
      pythonVersion: options.pythonVersion,
    })}\n`,
  );
  for (const relPath of [...byFile.keys()].sort()) {
    if (dead !== null) break;
    const lines = options.columns === true ? readSourceLines(options.corpusRoot, relPath) : null;
    // Successive sites on ONE line claim successive occurrences of the callee,
    // so `f(x), f(y)` does not pin both records to the leftmost `f`.
    const claimed = new Map<number, number>();
    const batch = (byFile.get(relPath) ?? []).map((site) => {
      const record = {
        startLine: site.call.startLine,
        callText: site.call.callText,
        receiver: site.call.receiver,
        member: site.call.member,
      };
      if (lines === null) return record;
      const from = claimed.get(record.startLine) ?? 0;
      const column = locateCalleeColumn(lines[record.startLine - 1] ?? "", record, from);
      if (column >= 0) claimed.set(record.startLine, column + record.member.length);
      return { ...record, column };
    });
    child.stdin.write(`${JSON.stringify({ kind: "file", relPath, sites: batch })}\n`);
  }
  if (dead === null) child.stdin.end();
  await done;
  return replies;
}

/** A source file's lines, or none when it cannot be read. */
function readSourceLines(corpusRoot: string, relPath: string): string[] {
  try {
    return readFileSync(join(corpusRoot, relPath), "utf8").split("\n");
  } catch {
    return [];
  }
}

export interface PyOracleEnginesOptions {
  corpusRoot: string;
  /** jedi's launcher — the primary, and the default engine. */
  jediArgv: string[];
  /** The second engine's launcher, spoken to only when the selection asks. */
  lspArgv: string[];
  venvPython: string | null;
  roots: readonly string[];
  workers: number;
  pythonVersion?: string;
  selection: OracleSelection;
  quiet?: boolean;
}

/**
 * Ask the engines the selection requires and merge them PER FILE.
 *
 * `merged` runs jedi FIRST and then asks the second engine only about the files
 * jedi reported damaged. That is not an optimisation of a symmetric design: the
 * second engine is a repair, so the population it answers is defined by jedi's
 * own report, and asking it about the whole corpus would spend ~4x the wall to
 * produce replies the merge would throw away.
 */
export async function askOracles(
  sites: readonly PyChainSite[],
  options: PyOracleEnginesOptions,
): Promise<Map<string, MergedOracleFileReply>> {
  const shared = {
    corpusRoot: options.corpusRoot,
    venvPython: options.venvPython,
    roots: options.roots,
    workers: options.workers,
  };
  if (options.selection === "lsp") {
    const only = await askOracle(sites, {
      ...shared,
      python: options.lspArgv,
      pythonVersion: options.pythonVersion,
      columns: true,
    });
    return new Map([...only].map(([relPath, reply]) => [relPath, { reply, engine: "lsp" as const }]));
  }

  const jedi = await askOracle(sites, { ...shared, python: options.jediArgv });
  if (options.selection === "jedi") {
    return new Map([...jedi].map(([relPath, reply]) => [relPath, { reply, engine: "jedi" as const }]));
  }

  const damaged = new Set(
    [...new Set(sites.map((site) => site.relPath))].filter((relPath) => {
      const reply = jedi.get(relPath);
      return reply === undefined || reply.parseFailed || reply.parsoErrors > 0;
    }),
  );
  if (options.quiet !== true) {
    process.stderr.write(`second oracle: ${String(damaged.size)} files jedi could not read cleanly\n`);
  }
  if (damaged.size === 0) {
    return new Map([...jedi].map(([relPath, reply]) => [relPath, { reply, engine: "jedi" as const }]));
  }
  const lsp = await askOracle(
    sites.filter((site) => damaged.has(site.relPath)),
    { ...shared, python: options.lspArgv, pythonVersion: options.pythonVersion, columns: true },
  );
  return mergeOracleReplies(jedi, lsp);
}

/**
 * How many bases the call site's enclosing class declares.
 *
 * `undefined` means the question does not apply: no enclosing class, or a run
 * whose index carries no `classAncestors` at all (walker v2). `0` is a real
 * answer — a class the walker recorded no base for, whose `super()` goes
 * straight to `object`.
 *
 * The key comes from the SAME helper `PythonSuperSymbolResolutionStrategy`
 * uses, so the count describes the class the super pass actually linearizes.
 * `callerScope` is not a list of class containers — it carries the enclosing
 * `def` for a call made from a nested one, and the enclosing `def` for a class
 * declared inside one — so joining it whole is not the class FQ (bd
 * tea-rags-mcp-graiw).
 */
export function countEnclosingBases(ctx: CallContext): number | undefined {
  if (ctx.callerScope === undefined || ctx.classAncestors === undefined) return undefined;
  const enclosing = pythonEnclosingClass(ctx);
  if (enclosing === null) return undefined;
  return ctx.classAncestors[enclosing.key]?.length ?? 0;
}

/**
 * Join the two answers into scored rows. Pure given its inputs.
 *
 * The reply map arrives in either shape: a plain `relPath -> reply` (what the
 * scratch row drivers hand it, and what `--oracle jedi` reduces to) or the
 * merged `relPath -> {reply, engine, legacy}`. `oracleEntryOf` discriminates
 * and defaults the provenance to `jedi`, the primary.
 *
 * A row whose file the second engine answered also carries `legacy`: the row
 * jedi's OWN reply produces for the same site, built by the same code off the
 * same per-file cursor. That is what makes the legacy tables reproduce a
 * jedi-only run — the shape categories, the origin and the degraded flag all
 * come from the answering engine, so substituting only the verdict would still
 * move the published columns (bd tea-rags-mcp-w205u).
 */
export function buildRows(
  sites: readonly PyChainSite[],
  replies: ReadonlyMap<string, PyOracleFileReply | MergedOracleFileReply>,
): PyOracleRow[] {
  const rows: PyOracleRow[] = [];
  const cursor = new Map<string, number>();
  for (const site of sites) {
    const { reply, engine, legacy } = oracleEntryOf(replies.get(site.relPath));
    const index = cursor.get(site.relPath) ?? 0;
    cursor.set(site.relPath, index + 1);
    const row = buildRow(site, reply, engine, index);
    rows.push(
      engine === "jedi" || legacy === undefined ? row : { ...row, legacy: buildRow(site, legacy, "jedi", index) },
    );
  }
  return rows;
}

/** One site's row against ONE engine's reply, at the per-file cursor position. */
function buildRow(
  site: PyChainSite,
  reply: PyOracleFileReply | undefined,
  engine: OracleEngine,
  index: number,
): PyOracleRow {
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
  // jedi walks `super()` through the first base only, so an external answer
  // on a MULTI-base `super()` site is not ground truth. The core withdraws it.
  const { oracle, categories } = applySuperMroBlindSpot({
    isSuperCall: isSuperCallSite({
      receiverKind: site.receiverKind,
      receiver: site.call.receiver,
      facts: answer?.siteFacts,
    }),
    origin: answer?.outcome.origin,
    oracle: reported,
    enclosingBaseCount: countEnclosingBases(site.ctx),
    categories: categorizePySite(answer?.siteFacts, {
      receiver: site.call.receiver,
      member: site.call.member,
    }),
  });
  return {
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
      // Read off the RAW answer, not the withdrawn one: the blind spot only
      // ever rewrites EXTERNAL origins, so the two cannot both fire.
      oracleTargetNonCallable: targets[0]?.defNodeKind === "nonCallable",
    }),
    answeredBy: site.answeredBy,
    chainOutput: site.chain === null ? "none" : site.chain.targetSymbolId === null ? "fileOnly" : "pinned",
    chain: site.chain ?? undefined,
    origin: answer?.outcome.origin,
    oracleDegraded: (reply?.parsoErrors ?? 0) > 0,
    unlocatedShape: answer?.unlocated,
    oracleEngine: engine,
  };
}

/**
 * jedi's launcher. `uv run --no-project` keeps jedi's environment out of the
 * corpus's, which is what lets one oracle build serve three interpreter
 * versions.
 */
export const JEDI_LAUNCHER = (interpreter: string): string[] => [
  "uv",
  "run",
  "--no-project",
  "--python",
  interpreter,
  "--with",
  "jedi==0.20.0",
  "python",
  join(import.meta.dirname, "py-oracle", "jedi_oracle.py"),
];

/**
 * The second oracle's launcher (bd tea-rags-mcp-w205u). The engine itself —
 * pyright, pinned and cache-local per D7 — is spawned by `lsp_oracle.ts`, so
 * swapping engines never reaches this record.
 */
export const LSP_LAUNCHER = (): string[] => ["npx", "tsx", join(import.meta.dirname, "py-oracle", "lsp_oracle.ts")];

export interface PyOracleCliOptions {
  corpusRoot: string;
  corpusName: string;
  venvPython: string | null;
  /** Absolute, manifest order — see `resolveCorpusRoots`. Never empty. */
  roots: string[];
  pythonArgv: string[];
  /** The second engine's launcher — spawned only when `oracle` asks for it. */
  lspArgv: string[];
  /** The manifest's `oraclePython`, handed to an engine that configures a grammar. */
  oraclePythonVersion: string;
  /** `jedi` (default, byte-identical to every published number), `lsp`, `merged`. */
  oracle: OracleSelection;
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
 *
 * The list is a PREFERENCE, not a fixed search order: `order_roots` on the
 * Python side promotes whichever of these contains the file being answered, so
 * two roots owning a package of the same name — polar's `server/polar` and
 * `sdk/python/polar` — each win inside their own subtree (vua9f).
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

/**
 * `--oracle jedi|lsp|merged`, defaulting to `jedi`.
 *
 * An unknown value THROWS rather than falling back: a typo that silently ran
 * the default would publish a jedi-denominator number under a merged label,
 * and the whole task exists to stop denominators moving unannounced.
 */
export function parseOracleSelection(value: string | undefined): OracleSelection {
  if (value === undefined) return "jedi";
  if (value === "jedi" || value === "lsp" || value === "merged") return value;
  throw new Error(`--oracle must be one of jedi|lsp|merged, got ${value}`);
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
    pythonArgv: JEDI_LAUNCHER(interpreter),
    lspArgv: LSP_LAUNCHER(),
    oraclePythonVersion: interpreter,
    oracle: parseOracleSelection(read("--oracle")),
    limit: Number(read("--limit") ?? Number.MAX_SAFE_INTEGER),
    samples: Number(read("--samples") ?? 25),
    seed: Number(read("--seed") ?? 20260908),
    workers: Number(read("--workers") ?? 8),
    json: read("--json") ?? null,
    quiet: argv.includes("--quiet"),
  };
}

/**
 * The two recall denominators side by side, never one alone.
 *
 * `recallLegacy` counts the rows jedi answered with the degraded ones withheld
 * from the rates, exactly as a jedi-only run withholds them — so it reproduces
 * every published Python number and is the regression gate. `recallMerged` is
 * what E4.1–E4.6 are measured against. Both `n` columns are printed rather than
 * inferred, so a reader can see which rows moved.
 *
 * Rows come out ordered by LABEL. A size key would print the same numbers in a
 * different order under `--oracle merged`, and the block has to diff clean
 * against a jedi-only run of the same corpus (bd tea-rags-mcp-w205u).
 */
export function formatRecallSplit(splits: readonly PyRecallSplit[]): string {
  const width = Math.max(12, ...splits.map((split) => split.label.length));
  const columns = ["recallLegacy", "nLegacy", "recallMerged", "nMerged", "+2ndEngine"];
  const header = ["receiverKind".padEnd(width), ...columns.map((column) => column.padStart(13))].join(" ");
  const lines = ["RECALL — BOTH DENOMINATORS (match / (match+fileOnly+wrongFile+missed))", "-".repeat(header.length)];
  lines.push(header, "-".repeat(header.length));
  if (splits.length === 0) return [...lines, "(no scored call sites)"].join("\n");
  for (const split of splits) {
    lines.push(
      [
        split.label.padEnd(width),
        split.recallLegacy.toFixed(3).padStart(13),
        String(split.nLegacy).padStart(13),
        split.recallMerged.toFixed(3).padStart(13),
        String(split.nMerged).padStart(13),
        String(split.nSecondEngine).padStart(13),
      ].join(" "),
    );
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const walk = await walkCorpus(options.corpusRoot, options.limit, options.quiet);
  const replies = await askOracles(walk.sites, {
    corpusRoot: options.corpusRoot,
    jediArgv: options.pythonArgv,
    lspArgv: options.lspArgv,
    venvPython: options.venvPython,
    roots: options.roots,
    workers: options.workers,
    pythonVersion: options.oraclePythonVersion,
    selection: options.oracle,
    quiet: options.quiet,
  });
  const rows = buildRows(walk.sites, replies);

  // The three published tables stay on the JEDI denominator whatever the
  // selection, so seam-4 / seam-5 / E3's records stay reproducible from them.
  // Every site jedi was asked about is here, including the ones the second
  // engine repaired: `legacyViewOf` hands back the row JEDI produced, degraded
  // and withheld from the rates but still counted in `sites`, which is what a
  // `--oracle jedi` run counts. Filtering by engine dropped those sites and
  // shrank the published `sites` column (bd tea-rags-mcp-w205u).
  // The merged block below repeats the same columns over every scored row.
  const legacyRows = rows.flatMap((row) => {
    const view = legacyViewOf(row);
    return view === undefined ? [] : [view];
  });
  const jediAnsweredRows = rows.filter((row) => row.oracleEngine === "jedi").length;
  const byReceiver = tallyPyRows(legacyRows, (row) => [row.receiverKind]);
  const byAnsweredBy = tallyPyRows(legacyRows, (row) => [row.answeredBy]);
  const byCategory = tallyPyRows(legacyRows, (row) => row.categories);
  const byReceiverMerged = tallyPyRows(rows, (row) => [row.receiverKind]);
  const byAnsweredByMerged = tallyPyRows(rows, (row) => [row.answeredBy]);
  const byCategoryMerged = tallyPyRows(rows, (row) => row.categories);
  const recallByReceiver = tallyPyRecall(rows, (row) => [row.receiverKind]);
  const secondEngineRows = rows.length - jediAnsweredRows;
  const secondEngineFiles = new Set(rows.filter((row) => row.oracleEngine !== "jedi").map((row) => row.relPath)).size;
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
    `skippedInProject ${coverage.skippedInProject} · oracleNonCallable ${coverage.oracleNonCallable} · unlocated ${coverage.unlocated} (${Object.entries(
      coverage.unlocatedByShape,
    )
      .map(([shape, count]) => `${shape} ${String(count)}`)
      .join(", ")})`,
    options.oracle === "lsp"
      ? `oracle lsp · every row answered by the second engine (${secondEngineRows} rows on ${secondEngineFiles} files) — recallLegacy reads 0/0 by construction`
      : `oracle ${options.oracle} · jedi answered ${jediAnsweredRows} rows · second engine ${secondEngineRows} rows on ${secondEngineFiles} files jedi could not read`,
    `elapsed ${((Date.now() - started) / 1000).toFixed(1)}s`,
    "",
    formatOracleTable("BY RECEIVER KIND (partition — each call site counted once)", byReceiver),
    "",
    formatOracleTable("BY ANSWERING PASS (partition — 'none' is the declined set)", byAnsweredBy),
    "",
    formatOracleTable("BY MISSED-SHAPE CATEGORY (rows overlap — a site can carry several)", byCategory),
    "",
    "=== MERGED DENOMINATOR (every scored row, whichever engine answered it) ===",
    "",
    formatOracleTable("BY RECEIVER KIND — merged denominator", byReceiverMerged),
    "",
    formatOracleTable("BY ANSWERING PASS — merged denominator", byAnsweredByMerged),
    "",
    formatOracleTable("BY MISSED-SHAPE CATEGORY — merged denominator", byCategoryMerged),
    "",
    formatRecallSplit(recallByReceiver),
    "",
  ];
  process.stdout.write(out.join("\n"));

  if (options.json !== null) {
    const payload = {
      corpus: options.corpusName,
      corpusRoot: options.corpusRoot,
      oracle: options.oracle,
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
        oracleNonCallable: coverage.oracleNonCallable,
        unlocated: coverage.unlocated,
        unlocatedByShape: coverage.unlocatedByShape,
        chainOutput,
        jediRows: jediAnsweredRows,
        secondEngineRows,
        secondEngineFiles,
      },
      byReceiver,
      byAnsweredBy,
      byCategory,
      // Both denominators, always. A merged-denominator table published without
      // its legacy twin is unreadable against every earlier record.
      byReceiverMerged,
      byAnsweredByMerged,
      byCategoryMerged,
      recallByReceiver,
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
