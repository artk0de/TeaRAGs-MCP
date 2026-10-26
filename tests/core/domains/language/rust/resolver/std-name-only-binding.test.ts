import { describe, expect, it } from "vitest";

import type { CallContext, CallRef, LocalBinding } from "../../../../../../src/core/contracts/types/codegraph.js";
import { RustCallResolver } from "../../../../../../src/core/domains/language/rust/resolver/rust-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

/**
 * RESIDUAL R5 (a): a std-prelude member or function name bound to the
 * corpus's only in-project namesake by NAME alone is the `Res#unwrap` /
 * `Response#Ok` false edge — wherever the rustc driver answered such a site it
 * named std. With no receiver-type evidence the edge drops and the miss is
 * external; any evidence (typed local, `self` of the declaring type, a path
 * naming the project type) keeps it.
 */

function member(t: InMemoryGlobalSymbolTable, relPath: string, owner: string, name: string): void {
  t.upsertFile(relPath, [
    { symbolId: `${owner}#${name}`, fqName: `${owner}#${name}`, shortName: name, relPath, scope: [owner] },
  ]);
}

function ctx(
  t: InMemoryGlobalSymbolTable,
  opts: { callerFile?: string; callerScope?: string[]; localBindings?: Record<string, LocalBinding[]> } = {},
): CallContext {
  return {
    callerFile: opts.callerFile ?? "src/main.rs",
    callerScope: opts.callerScope ?? [],
    imports: [],
    symbolTable: t,
    ...(opts.localBindings ? { localBindings: opts.localBindings } : {}),
  };
}

function resTable(): InMemoryGlobalSymbolTable {
  const t = new InMemoryGlobalSymbolTable();
  member(t, "src/codec/decimal.rs", "Res", "unwrap");
  return t;
}

describe("Rust resolver — std-prelude names bound by name alone (RESIDUAL R5)", () => {
  it("drops `x.unwrap()` on an untyped receiver bound only to the lone project `Res#unwrap`, as external", () => {
    const r = new RustCallResolver();
    const t = resTable();
    const call: CallRef = { callText: "opt.cmd.unwrap()", receiver: "opt.cmd", member: "unwrap", startLine: 9 };
    expect(r.resolve(call, ctx(t))).toBeNull();
    expect(r.targetsExternalImport?.(call, ctx(t))).toBe(true);
  });

  it("drops a bare `Ok(v)` bound only to the lone project `Response#Ok`, as external", () => {
    const r = new RustCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    member(t, "components/script/dom/response.rs", "Response", "Ok");
    const call: CallRef = { callText: "Ok(v)", receiver: null, member: "Ok", startLine: 4 };
    expect(r.resolve(call, ctx(t))).toBeNull();
    expect(r.targetsExternalImport?.(call, ctx(t))).toBe(true);
  });

  it("drops a bare `Ok(v)` inside `impl Response` — a bare call never reaches an associated item", () => {
    const r = new RustCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    member(t, "components/script/dom/response.rs", "Response", "Ok");
    const inImpl = ctx(t, { callerFile: "components/script/dom/response.rs", callerScope: ["Response"] });
    const call: CallRef = { callText: "Ok(v)", receiver: null, member: "Ok", startLine: 40 };
    expect(r.resolve(call, inImpl)).toBeNull();
    expect(r.targetsExternalImport?.(call, inImpl)).toBe(true);
  });

  it("keeps `self.unwrap()` inside `impl Res`", () => {
    const r = new RustCallResolver();
    const t = resTable();
    const target = r.resolve(
      { callText: "self.unwrap()", receiver: "self", member: "unwrap", startLine: 30 },
      ctx(t, { callerFile: "src/codec/decimal.rs", callerScope: ["Res"] }),
    );
    expect(target?.targetSymbolId).toBe("Res#unwrap");
  });

  it("keeps `r.unwrap()` when `r` is declared `Res<T>`", () => {
    const r = new RustCallResolver();
    const t = resTable();
    const target = r.resolve(
      { callText: "r.unwrap()", receiver: "r", member: "unwrap", startLine: 5 },
      ctx(t, {
        localBindings: {
          r: [
            {
              line: 4,
              type: "Res",
              typeRef: { form: "instance", name: "Res", args: [{ form: "instance", name: "T" }] },
            },
          ],
        },
      }),
    );
    expect(target?.targetSymbolId).toBe("Res#unwrap");
  });

  it("keeps the path call `Res::unwrap(r)`", () => {
    const r = new RustCallResolver();
    const t = resTable();
    const target = r.resolve({ callText: "Res::unwrap(r)", receiver: "Res", member: "unwrap", startLine: 5 }, ctx(t));
    expect(target?.targetSymbolId).toBe("Res#unwrap");
  });

  it("keeps today's name binding for a non-prelude unique name", () => {
    const r = new RustCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    member(t, "src/codec/decimal.rs", "Res", "frobnicate");
    const call: CallRef = { callText: "x.frobnicate()", receiver: "x", member: "frobnicate", startLine: 5 };
    expect(r.resolve(call, ctx(t))?.targetSymbolId).toBe("Res#frobnicate");
  });
});
