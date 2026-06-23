/**
 * bd tea-rags-mcp-6x6e — RESOLVE REGRESSION GATE (metric backbone of epic ba9u).
 *
 * Drives the REAL `CodegraphEnrichmentProvider` streaming sink (parse → walk →
 * resolve → tally) over a small, checked-in multi-file TypeScript fixture with
 * KNOWN call-sites, then reads `getRunMetrics()` and asserts EXACT per-
 * receiverKind {attempted, resolved} counts plus the overall resolveSuccessRate.
 *
 * Determinism is GUARANTEED (yl9tv: spill sorted by relPath; svhqp: runStats
 * reset at run start), so a fixture run is byte-reproducible and the numbers can
 * be pinned exactly. Any resolver / walker / classifier regression that loses a
 * resolution (or mis-buckets a receiver) flips this test — protecting the
 * j431 (per-kind instrument), ykj7 (external classification), 2yfi (localVar
 * bindings), and k4wpn (interface→impl CHA cone) gains.
 *
 * The fixture (inline file map written to a temp dir, mirroring the convention
 * in provider-run-stats.test.ts — no on-disk fixture dir) drives one call-site
 * per TypeScript receiver idiom, with both resolvable and correctly-external /
 * correctly-unresolved cases. The receiverKind classifier
 * (receiver-kind.ts) buckets each by the call's receiver text + the chunk's
 * localBindings — its TS-specific verdicts are baked into the expectations
 * below (e.g. `this.X()` → `dynamic`, not `selfMember`, since `selfMember`
 * keys off Ruby's `self`; a `new X()` constructor is a `constant` receiver):
 *
 *   helper()         → bareCall  → util.helper (resolvable)
 *   tbl[k]()         → bareCall  → element-reference, no nameable receiver
 *                                  (correctly unresolved)
 *   super.base()     → super     → Base#base via classExtends (resolvable)
 *   this.helper2()   → dynamic   → Service#helper2 (resolvable; `this`≠`self`)
 *   const w: Widget; w.render() → localVar → Widget#render (resolvable, 2yfi)
 *   r.go() (r: Runner, 2 impls) → localVar → CHA cone over RunnerA/RunnerB
 *                                  (resolvable, k4wpn; typed param ⇒ localVar)
 *   Foo.staticBar()  → constant  → Foo.staticBar via import (resolvable)
 *   new Widget()/new Dep() → constant → X#constructor (resolvable)
 *   Math.max(...)    → constant  → ECMAScript ambient global (external-skipped)
 *   this.dep.run()   → chain     → Dep#run via field type (resolvable)
 *
 * NOTE on addressable-miss: runStats does NOT track the "unresolved call whose
 * member short-name exists in the symbol table" notion, and the task forbids
 * adding new production tracking here. So this gate asserts EXACT resolved /
 * attempted per kind (a sufficient regression gate) instead of addressable-miss.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTestCodegraphDeps } from "../__helpers__/language-factory.js";
import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { runMigrations } from "../../../../../../src/core/infra/migration/database/runner.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIG_DIR = resolve(__dirname, "../../../../../../src/core/infra/migration/database/migrations");

interface ResolveKindTally {
  attempted: number;
  resolved: number;
  rate: number;
}

/** Files keyed by repo-relative path, exercising every receiverKind. */
const FIXTURE: Record<string, string> = {
  // Same-file helper functions (bareCall resolvable targets) + a Widget class
  // with an instance method (localVar resolvable target).
  "src/util.ts": [
    "export function helper(): number {",
    "  return 1;",
    "}",
    "export class Widget {",
    "  render(): number {",
    "    return 2;",
    "  }",
    "}",
  ].join("\n"),
  // A static class (constant resolvable target).
  "src/foo.ts": ["export class Foo {", "  static staticBar(): number {", "    return 3;", "  }", "}"].join("\n"),
  // A base class for the `super` case.
  "src/base.ts": ["export class Base {", "  base(): number {", "    return 4;", "  }", "}"].join("\n"),
  // An in-repo dependency class used through a `this.field` chain.
  "src/dep.ts": ["export class Dep {", "  run(): number {", "    return 5;", "  }", "}"].join("\n"),
  // An interface with TWO in-repo implementers — drives the CHA cone (k4wpn).
  "src/runner.ts": [
    "export interface Runner {",
    "  go(): number;",
    "}",
    "export class RunnerA implements Runner {",
    "  go(): number {",
    "    return 6;",
    "  }",
    "}",
    "export class RunnerB implements Runner {",
    "  go(): number {",
    "    return 7;",
    "  }",
    "}",
  ].join("\n"),
  // The driver file: one call-site per receiverKind.
  "src/main.ts": [
    'import { helper, Widget } from "./util.js";',
    'import { Foo } from "./foo.js";',
    'import { Base } from "./base.js";',
    'import { Dep } from "./dep.js";',
    'import { Runner } from "./runner.js";',
    "",
    "export class Service extends Base {",
    "  private dep = new Dep();", // constant → Dep#constructor (resolvable, field init call)
    "  helper2(): number {",
    "    return 10;",
    "  }",
    "  run(r: Runner, tbl: Record<string, () => number>, k: string): number {",
    "    const w: Widget = new Widget();", // constant → Widget#constructor (resolvable)
    "    super.base();", // super → Base#base via classExtends (resolvable)
    "    this.helper2();", // dynamic → Service#helper2 (`this`≠`self`) (resolvable)
    "    helper();", // bareCall → util.helper (resolvable)
    "    Foo.staticBar();", // constant → Foo.staticBar (resolvable)
    "    Math.max(1, 2);", // constant → ECMAScript ambient global (external-skipped)
    "    w.render();", // localVar → Widget#render (resolvable, 2yfi)
    "    this.dep.run();", // chain → Dep#run via field type (resolvable)
    "    r.go();", // localVar → CHA cone over RunnerA/RunnerB (resolvable, k4wpn)
    "    return tbl[k]();", // bareCall → element-reference, unresolvable (correctly unresolved)
    "  }",
    "}",
  ].join("\n"),
};

function writeFixture(root: string): string[] {
  mkdirSync(join(root, "src"), { recursive: true });
  const paths: string[] = [];
  for (const [rel, src] of Object.entries(FIXTURE)) {
    writeFileSync(join(root, rel), `${src}\n`);
    paths.push(rel);
  }
  return paths;
}

describe("CodegraphEnrichmentProvider — resolve regression gate (6x6e)", () => {
  let tmp: string;
  let root: string;
  let client: DuckDbGraphClient;
  let provider: CodegraphEnrichmentProvider;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-resolve-gate-"));
    root = mkdtempSync(join(tmpdir(), "cg-resolve-fixture-"));
    client = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
    await client.init();
    await runMigrations(client, MIG_DIR);
    provider = new CodegraphEnrichmentProvider({
      graphDb: client,
      symbolTable: new InMemoryGlobalSymbolTable(),
      ...buildTestCodegraphDeps(),
      composer: new DefaultSymbolIdComposer(),
      collectSymbols,
    });
  });

  afterEach(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it("pins exact per-receiverKind resolution over the fixture", async () => {
    const paths = writeFixture(root);
    // Symbol-collection pass first (so the symbol table is populated), then the
    // edge-resolution pass over the same files. streamFileBatch does both for
    // the streaming entry; finalizeSignals flushes + lets getRunMetrics read.
    await provider.streamFileBatch(root, paths);
    await provider.finalizeSignals(root);

    const metrics = provider.getRunMetrics();
    expect(metrics).toBeDefined();
    const byKind = metrics!.resolveByReceiverKind as Record<string, ResolveKindTally>;

    // PINNED EXPECTATIONS — deterministic over the fixture (see per-kind notes).
    //
    // constant  4/3 : new Widget() ✓ + new Dep() ✓ (constructors are constant-
    //                 receiver calls) + Foo.staticBar() ✓ (static via import);
    //                 Math.max() ✗ — ECMAScript ambient global, external-skipped
    //                 (ykj7) → drops out of the success denominator.
    // localVar  2/2 : w.render() ✓ (w typed Widget, 2yfi local binding) +
    //                 r.go() ✓ (r param typed Runner → CHA cone over RunnerA/
    //                 RunnerB, k4wpn; the param is a typed local so it buckets
    //                 here, and the cone fan-out counts the call as resolved).
    // super     1/1 : super.base() ✓ via the classExtends chain (Service→Base).
    // bareCall  2/1 : helper() ✓ (same-file/imported fn); tbl[k]() ✗ — the
    //                 element-reference call has no nameable receiver, emitted as
    //                 a bare call and correctly left unresolved.
    // chain     1/1 : this.dep.run() ✓ — this.field.method() via field type Dep.
    // dynamic   1/1 : this.helper2() ✓ — `this` receiver (TS has no `self`
    //                 idiom) buckets as dynamic, resolved against the enclosing
    //                 class Service.
    // selfMember/ivar/index 0 : Ruby-only idioms (self/@ivar) and the index
    //                 receiver shape never arise for this TS fixture.
    const expected: Record<string, { attempted: number; resolved: number }> = {
      constant: { attempted: 4, resolved: 3 },
      localVar: { attempted: 2, resolved: 2 },
      super: { attempted: 1, resolved: 1 },
      bareCall: { attempted: 2, resolved: 1 },
      chain: { attempted: 1, resolved: 1 },
      dynamic: { attempted: 1, resolved: 1 },
      selfMember: { attempted: 0, resolved: 0 },
      ivar: { attempted: 0, resolved: 0 },
      index: { attempted: 0, resolved: 0 },
    };
    for (const [kind, want] of Object.entries(expected)) {
      expect(byKind[kind], `receiverKind ${kind}`).toMatchObject(want);
    }

    // Overall rate: 9 resolved / 10 internal-attempted (11 total − 1 external-
    // skipped). Any resolver/walker regression that loses a resolution or mis-
    // buckets a receiver shifts these counts and flips the gate.
    const totalAttempted = Object.values(expected).reduce((s, t) => s + t.attempted, 0);
    const totalResolved = Object.values(expected).reduce((s, t) => s + t.resolved, 0);
    expect(totalAttempted).toBe(11);
    expect(totalResolved).toBe(9);
    expect(metrics!.callsExternalSkipped).toBe(1);
    expect(metrics!.resolveSuccessRate).toBeCloseTo(0.9, 10);
  });
});
