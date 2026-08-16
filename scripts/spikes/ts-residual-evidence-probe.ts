/**
 * What EVIDENCE exists for the calls that stay in the `resolveSuccessRate`
 * denominator (bd tea-rags-mcp-6o7bi)?
 *
 * `scripts/spikes/live-resolve-buckets.ts` reports the buckets; this asks the
 * follow-up question about the residual it leaves — the calls the chain could
 * not pin, that `targetsExternalImport` did not call external, whose member DOES
 * have an in-project definition, and that are not core homonyms. Those are the
 * denominator, and the honest rate depends entirely on whether they are resolver
 * failures or calls that provably leave the project.
 *
 * Per residual call it records what the type checker can say, in the two shapes
 * the guard family already uses:
 *
 *   - RECEIVER type declared outside the project — what
 *     `checkerTypesReceiverOutsideProject` reads (case 4b of the guard);
 *   - the CALL's resolved SIGNATURE declared outside the project — what
 *     `scripts/ts-codegraph-typechecker-oracle.ts` reads, and what the
 *     `typeCheckerFallback` pass throws away when the answer is "outside".
 *
 * Usage:
 *   npx tsx scripts/spikes/ts-residual-evidence-probe.ts \
 *     --repo-root /path/to/repo --target app/javascript [--resolve ui-kit] [--kind localVar]
 */

import { relative, resolve as resolvePath } from "node:path";

import ts from "typescript";

import type { CallRef, FileExtraction, RelPath } from "../../src/core/contracts/types/codegraph.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../src/core/domains/language/index.js";
import { loadTsConfig, TSCallResolver } from "../../src/core/domains/language/typescript/index.js";
import { findCallExpression } from "../../src/core/domains/language/typescript/resolver/strategies/ts-type-checker-fallback.js";
import { findReceiverExpression } from "../../src/core/domains/language/typescript/resolver/strategies/ts-type-checker-shared.js";
import type { TSProgramCache } from "../../src/core/domains/language/typescript/resolver/ts-program-cache.js";
import { classifyReceiverKind } from "../../src/core/domains/trajectory/codegraph/symbols/receiver-kind.js";
import { InMemoryGlobalSymbolTable } from "../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { buildCallContext, buildSymbolDefs, collectSourceFiles, extractFile } from "../ts-codegraph-typechecker-oracle.js";

/** Where the checker says the CALL's selected signature is declared. */
type SignatureEvidence = "outsideProject" | "inProject" | "noDeclaration" | "nodeNotLocated" | "noProgram";

interface KindReport {
  residual: number;
  signature: Map<SignatureEvidence, number>;
  /** Of the `outsideProject` residual, how many the RECEIVER-type arm also sees. */
  receiverAlsoOutside: number;
  /** …and how many an intersection-walking receiver arm would see. */
  receiverDeepOutside: number;
  /**
   * …and how many have a receiver whose type NAMES a project declaration — the
   * population bd tea-rags-mcp-otm6n's recall guard protects (a project class
   * extending a dependency's), which a callee-signature arm must not decline.
   */
  receiverNamesProject: number;
  samples: string[];
}

const emptyReport = (): KindReport => ({
  residual: 0,
  signature: new Map(),
  receiverAlsoOutside: 0,
  receiverDeepOutside: 0,
  receiverNamesProject: 0,
  samples: [],
});

const bump = <K>(m: Map<K, number>, k: K): void => m.set(k, (m.get(k) ?? 0) + 1);

function argOf(argv: readonly string[], flag: string, fallback: string): string {
  const i = argv.indexOf(flag);
  return i === -1 ? fallback : (argv[i + 1] ?? fallback);
}

/** Mirrors `typeDeclaredOutsideProject` — every UNION constituent declared outside the project. */
function receiverTypeOutsideProject(checker: ts.TypeChecker, type: ts.Type, cache: TSProgramCache): boolean {
  for (const constituent of type.isUnion() ? type.types : [type]) {
    const symbol = checker.getApparentType(constituent).getSymbol();
    if (symbol === undefined) return false;
    const declarations = symbol.getDeclarations() ?? [];
    if (declarations.length === 0) return false;
    if (declarations.some((d) => cache.isProjectSourceFile(d.getSourceFile().fileName))) return false;
  }
  return true;
}

/** Mirrors `typeNamesProjectDeclaration` — ANY constituent declared in the project. */
function receiverNamesProjectDeclaration(checker: ts.TypeChecker, type: ts.Type, cache: TSProgramCache): boolean {
  const parts = type.isUnionOrIntersection() ? type.types : [type];
  for (const constituent of parts) {
    const apparent = checker.getApparentType(constituent);
    if (apparent.isUnionOrIntersection() && apparent !== type) {
      if (receiverNamesProjectDeclaration(checker, apparent, cache)) return true;
      continue;
    }
    for (const declaration of apparent.getSymbol()?.getDeclarations() ?? []) {
      if (cache.isProjectSourceFile(declaration.getSourceFile().fileName)) return true;
    }
  }
  return false;
}

/** The same question with INTERSECTION constituents walked as well — the candidate widening. */
function receiverTypeOutsideProjectDeep(checker: ts.TypeChecker, type: ts.Type, cache: TSProgramCache): boolean {
  const parts = type.isUnionOrIntersection() ? type.types : [type];
  for (const constituent of parts) {
    const apparent = checker.getApparentType(constituent);
    if (apparent.isUnionOrIntersection() && apparent !== type) {
      if (!receiverTypeOutsideProjectDeep(checker, apparent, cache)) return false;
      continue;
    }
    const declarations = apparent.getSymbol()?.getDeclarations() ?? [];
    if (declarations.length === 0) return false;
    if (declarations.some((d) => cache.isProjectSourceFile(d.getSourceFile().fileName))) return false;
  }
  return true;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const repoRoot = resolvePath(process.cwd(), argOf(argv, "--repo-root", process.cwd()));
  const targetArg = argOf(argv, "--target", "src");
  const resolvePrefix = argOf(argv, "--resolve", "");
  const sampleCap = Number(argOf(argv, "--samples", "12"));

  const composer = new DefaultSymbolIdComposer();
  const factory = new LanguageFactory();
  const tsOptions = loadTsConfig(repoRoot);
  const resolver = new TSCallResolver(tsOptions, "strict", repoRoot);
  // The resolver's OWN cache, never a second one: two caches mean two whole-project
  // Programs, and the probe would measure a configuration production never runs.
  const cache = resolver.programCache;
  if (cache === null) throw new Error("CODEGRAPH_TS_TYPECHECKER is off — the probe has nothing to ask");
  const symbolTable = new InMemoryGlobalSymbolTable();

  const files: RelPath[] = await collectSourceFiles(repoRoot, resolvePath(repoRoot, targetArg));
  const extractions: FileExtraction[] = [];
  const classExtends: Record<string, string> = {};
  for (const relPath of files) {
    const extraction = extractFile(repoRoot, relPath, composer, factory);
    if (extraction === null) continue;
    symbolTable.upsertFile(relPath, buildSymbolDefs(extraction));
    Object.assign(classExtends, extraction.classExtends ?? {});
    extractions.push(extraction);
  }
  process.stderr.write(`pass 1: ${extractions.length} files, ${symbolTable.size()} symbols\n`);

  const byKind = new Map<string, KindReport>();
  const reportFor = (kind: string): KindReport => {
    const existing = byKind.get(kind);
    if (existing) return existing;
    const fresh = emptyReport();
    byKind.set(kind, fresh);
    return fresh;
  };

  const scope = extractions.filter((e) => e.relPath.startsWith(resolvePrefix));
  let done = 0;
  for (const extraction of scope) {
    for (const chunk of extraction.chunks) {
      const ctx = buildCallContext(extraction, chunk, classExtends, symbolTable);
      for (const call of (chunk.calls ?? []) as CallRef[]) {
        if (call.dispatch !== undefined) continue;
        if (resolver.resolve(call, ctx)) continue;
        if (call.dynamicSend === true) continue;
        if (resolver.targetsExternalImport?.(call, ctx)) continue;
        if (symbolTable.lookupByShortName(call.member).length === 0) continue;
        if (resolver.targetsCoreAmbiguousMember?.(call, ctx)) continue;

        const report = reportFor(classifyReceiverKind(call, chunk.localBindings));
        report.residual += 1;

        const handle = cache.acquire(extraction.relPath);
        if (handle === null) {
          bump(report.signature, "noProgram");
          continue;
        }
        const node = findCallExpression(handle.sourceFile, call.startLine, call.member);
        if (node === null) {
          bump(report.signature, "nodeNotLocated");
          continue;
        }
        const declaration = handle.checker.getResolvedSignature(node)?.declaration;
        if (declaration === undefined) {
          bump(report.signature, "noDeclaration");
          continue;
        }
        const fileName = declaration.getSourceFile().fileName;
        const outside = !cache.isProjectSourceFile(fileName);
        bump(report.signature, outside ? "outsideProject" : "inProject");
        if (!outside) continue;

        const receiverNode = findReceiverExpression(handle.sourceFile, call.startLine, call.member);
        const receiverType = receiverNode === null ? null : handle.checker.getTypeAtLocation(receiverNode);
        const shallow = receiverType !== null && receiverTypeOutsideProject(handle.checker, receiverType, cache);
        const deep = receiverType !== null && receiverTypeOutsideProjectDeep(handle.checker, receiverType, cache);
        const namesProject =
          receiverType !== null && receiverNamesProjectDeclaration(handle.checker, receiverType, cache);
        if (shallow) report.receiverAlsoOutside += 1;
        if (deep) report.receiverDeepOutside += 1;
        if (namesProject) report.receiverNamesProject += 1;
        if (!deep && !namesProject && report.samples.length < sampleCap) {
          report.samples.push(
            `${extraction.relPath}:${call.startLine} ${call.callText.split("\n")[0]} -> ${relative(repoRoot, fileName)}`,
          );
        }
      }
    }
    done += 1;
    if (done % 100 === 0) process.stderr.write(`pass 2: ${done}/${scope.length}\n`);
  }

  const kinds = [...byKind.entries()].sort((a, b) => b[1].residual - a[1].residual);
  process.stdout.write(`\nRESIDUAL EVIDENCE — ${targetArg}${resolvePrefix ? ` / ${resolvePrefix}` : ""} @ ${repoRoot}\n\n`);
  process.stdout.write(
    "kind         residual  sigOutside  recvUnion  recvDeep  recvProject  sigInProject  sigNoDecl  noNode  noProgram\n",
  );
  for (const [kind, r] of kinds) {
    const g = (k: SignatureEvidence): number => r.signature.get(k) ?? 0;
    process.stdout.write(
      `${kind.padEnd(11)} ${String(r.residual).padStart(8)}  ${String(g("outsideProject")).padStart(10)}  ` +
        `${String(r.receiverAlsoOutside).padStart(9)}  ${String(r.receiverDeepOutside).padStart(8)}  ` +
        `${String(r.receiverNamesProject).padStart(11)}  ` +
        `${String(g("inProject")).padStart(12)}  ` +
        `${String(g("noDeclaration")).padStart(9)}  ${String(g("nodeNotLocated")).padStart(6)}  ${String(g("noProgram")).padStart(9)}\n`,
    );
  }
  for (const [kind, r] of kinds) {
    if (r.samples.length === 0) continue;
    process.stdout.write(`\n${kind} — signature outside project, intersection-walking receiver arm still blind:\n`);
    for (const s of r.samples) process.stdout.write(`  ${s}\n`);
  }
  process.stdout.write("\n");
}

void main();
