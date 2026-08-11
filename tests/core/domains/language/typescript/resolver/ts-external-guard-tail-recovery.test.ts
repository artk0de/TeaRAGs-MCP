import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type CallRef,
  type NamedSymbol,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import { TSCallResolver } from "../../../../../../src/core/domains/language/typescript/resolver/ts-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const tsOptions = { baseUrl: ".", paths: {} };

function writeSource(repoRoot: string, relPath: string, content: string): void {
  const abs = join(repoRoot, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

const sym = (symbolId: string, shortName: string, relPath: string, scope: string[]): NamedSymbol => ({
  symbolId,
  fqName: symbolId,
  shortName,
  relPath,
  scope,
});

/**
 * Two project `push`es. The decoy is what a bare short-name match would have to
 * choose between, and it is why the recovery below is the CHECKER's answer
 * rather than a lucky single-candidate lookup.
 */
const twoPushTable = (): InMemoryGlobalSymbolTable => {
  const table = new InMemoryGlobalSymbolTable();
  table.upsertFile("src/sink.ts", [sym("EventSink#push", "push", "src/sink.ts", ["EventSink"])]);
  table.upsertFile("src/backlog.ts", [sym("Backlog#push", "push", "src/backlog.ts", ["Backlog"])]);
  return table;
};

const ctx = (callerFile: string, over: Partial<CallContext> = {}): CallContext => ({
  callerFile,
  callerScope: [],
  imports: [{ importText: "./sink.js", startLine: 1, importedNames: ["makeSink"] }],
  symbolTable: twoPushTable(),
  ...over,
});

/**
 * Case 4 of the guard, exactly: the receiver comes from a CALL so the walker
 * binds no type to it, and `push` is in the builtin-only prototype vocabulary.
 * The guard therefore answers "external" on the member name alone, WITHOUT
 * consulting the checker — while the checker, asked later, types the receiver as
 * a project class.
 *
 * The receiver is deliberately NOT named `sink`: a receiver whose name matches
 * the imported module's basename is decided by the imported-container arm
 * instead, and this fixture is about the heuristic arm.
 */
function writeUntypedProjectReceiverFixture(repoRoot: string): void {
  writeSource(
    repoRoot,
    "src/sink.ts",
    [
      `export class EventSink {`,
      `  push(event: string): void {`,
      `    void event;`,
      `  }`,
      `}`,
      ``,
      `export function makeSink(): EventSink {`,
      `  return new EventSink();`,
      `}`,
      ``,
    ].join("\n"),
  );
  writeSource(
    repoRoot,
    "src/emitter.ts",
    [
      `import { makeSink } from "./sink.js";`,
      ``,
      `export function emit(event: string): void {`,
      `  const collected = makeSink();`,
      `  collected.push(event);`,
      `}`,
      ``,
    ].join("\n"),
  );
}

const UNTYPED_PROJECT_RECEIVER_PUSH: CallRef = {
  callText: "collected.push(event)",
  receiver: "collected",
  member: "push",
  startLine: 5,
};

/**
 * bd tea-rags-mcp-owu84 — the external guard returns CONTINUE, not `drop`, and
 * that is a load-bearing choice rather than an oversight awaiting optimisation.
 *
 * `targetsExternalImport` guards passes 9 and 10, and case 4 of it decides on the
 * MEMBER NAME when nothing typed the receiver — "near-certainly external", not
 * "provably". So the guard's verdict is a heuristic that the checker-backed tail
 * (passes 11-14) is entitled to overturn, and on this repo's own `src` it
 * overturns it 22 times: flipping the guard to `drop` measured
 * edges 6332 -> 6310, file-only 565 -> 558, unresolved 8538 -> 8560, and the
 * oracle's true-defect residual rose from `missed 22` to `missed 37` defects.
 * The prize for that loss was nothing measurable — 20.96s vs 21.00s user CPU on
 * alternating full-`src` oracle runs — because the calls the guard declines are
 * precisely the ones passes 11-14 bail out of cheapest.
 *
 * Every other test of this guard asserts the chain returns `null`, which `drop`
 * satisfies just as well; only the strategy-level assertions pin the literal
 * outcome kind, and those are the first thing a "fix the tests" pass rewrites.
 * This test pins the CONSEQUENCE instead — a guard-declined call still reaching
 * a later pass and coming back with the right edge — so the invariant survives
 * an edit that changes the word `CONTINUE`.
 */
describe("TSCallResolver — an externally-guarded call still reaches the checker-backed tail (bd tea-rags-mcp-owu84)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-external-guard-tail-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("declines collected.push(event) at the guard — the receiver is untyped and `push` is builtin vocabulary", () => {
    writeUntypedProjectReceiverFixture(repoRoot);
    const resolver = new TSCallResolver(tsOptions, DEFAULT_AMBIGUOUS_RESOLVE_MODE, repoRoot);

    expect(resolver.targetsExternalImport(UNTYPED_PROJECT_RECEIVER_PUSH, ctx("src/emitter.ts"))).toBe(true);
  });

  it("STILL emits EventSink#push, because the chain continues past the guard to the passes that can type the receiver", () => {
    writeUntypedProjectReceiverFixture(repoRoot);
    const resolver = new TSCallResolver(tsOptions, DEFAULT_AMBIGUOUS_RESOLVE_MODE, repoRoot);

    // The edge exists ONLY because the guard continued. A `drop` here would stop
    // the chain at pass 9 and return null — silently, with every other test in
    // the suite still green.
    expect(resolver.resolve(UNTYPED_PROJECT_RECEIVER_PUSH, ctx("src/emitter.ts"))).toEqual({
      targetRelPath: "src/sink.ts",
      targetSymbolId: "EventSink#push",
    });
  });

  it("picks the receiver's own class, not the other project `push` a short-name match would have to guess between", () => {
    writeUntypedProjectReceiverFixture(repoRoot);
    const resolver = new TSCallResolver(tsOptions, DEFAULT_AMBIGUOUS_RESOLVE_MODE, repoRoot);

    const target = resolver.resolve(UNTYPED_PROJECT_RECEIVER_PUSH, ctx("src/emitter.ts"));

    expect(target?.targetSymbolId).not.toBe("Backlog#push");
  });
});
