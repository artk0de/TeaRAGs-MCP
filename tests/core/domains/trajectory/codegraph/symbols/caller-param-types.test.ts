/**
 * bd tea-rags-mcp-2m83f.44 — binding caller arguments to callee parameters and
 * the agreement rule that types a parameter from its callers.
 */
import { describe, expect, it } from "vitest";

import type { TypeRef } from "../../../../../../src/core/contracts/types/language.js";
import {
  agreedCallerParamTypes,
  bindCallArgsToParams,
  changedCallerParamTargets,
  foldCallerParamTypes,
} from "../../../../../../src/core/domains/trajectory/codegraph/symbols/caller-param-types.js";

const invoice: TypeRef = { form: "instance", name: "Invoice" };
const client: TypeRef = { form: "instance", name: "Client" };

describe("bindCallArgsToParams (2m83f.44)", () => {
  it("binds positions to the leading required names and keywords by name", () => {
    const bound = bindCallArgsToParams(
      { target: "W#perform", positional: [invoice], argCount: 1, keyword: { firm: client } },
      { positional: ["record"], maxPositional: 1, keywords: ["firm"] },
    );
    expect(bound).toEqual(
      new Map([
        ["record", invoice],
        ["firm", client],
      ]),
    );
  });

  it("an untypeable argument binds its parameter to null — an untyped caller", () => {
    const bound = bindCallArgsToParams({ target: "W#p", positional: [], argCount: 1 }, { positional: ["record"] });
    expect(bound).toEqual(new Map([["record", null]]));
  });

  it("a positional splat binds no positional parameter", () => {
    const bound = bindCallArgsToParams({ target: "W#p", positional: [] }, { positional: ["record"], keywords: [] });
    expect(bound?.size).toBe(0);
  });

  it("a `**opts` binds no keyword parameter", () => {
    const bound = bindCallArgsToParams(
      { target: "W#p", positional: [], argCount: 0, keyword: { record: invoice }, hasKwargSplat: true },
      { positional: [], keywords: ["record"] },
    );
    expect(bound?.size).toBe(0);
  });

  it("a declared keyword the site does not pass is an untyped caller (its default)", () => {
    const bound = bindCallArgsToParams(
      { target: "W#p", positional: [], argCount: 0 },
      { positional: [], keywords: ["record"] },
    );
    expect(bound).toEqual(new Map([["record", null]]));
  });

  it("a keyword the callee does not declare binds nothing", () => {
    const bound = bindCallArgsToParams(
      { target: "W#p", positional: [], argCount: 0, keyword: { other: invoice } },
      { positional: [], keywords: [] },
    );
    expect(bound?.size).toBe(0);
  });

  it("refuses the whole site when its argument count exceeds the callee's capacity", () => {
    const bound = bindCallArgsToParams(
      { target: "W#p", positional: [invoice, client], argCount: 2 },
      { positional: ["record"], maxPositional: 1, hasRestPositional: false },
    );
    expect(bound).toBeNull();
  });
});

describe("foldCallerParamTypes (2m83f.44)", () => {
  const site = (target: string, type: TypeRef | null) => ({
    target,
    params: new Map<string, TypeRef | null>([["record", type]]),
  });

  it("agreeing typed callers type the parameter", () => {
    const evidence = foldCallerParamTypes([site("W#p", invoice), site("W#p", invoice)]);
    expect(agreedCallerParamTypes(evidence)).toEqual({ "W#p": { record: invoice } });
    expect(evidence["W#p"].record).toMatchObject({ typedCallers: 2, untypedCallers: 0 });
  });

  it("disagreeing callers type nothing but keep every type as evidence", () => {
    const evidence = foldCallerParamTypes([site("W#p", invoice), site("W#p", client)]);
    expect(agreedCallerParamTypes(evidence)).toEqual({});
    expect(evidence["W#p"].record.types).toEqual([invoice, client]);
  });

  it("untyped callers do not veto while they do not outnumber the typed ones", () => {
    const evidence = foldCallerParamTypes([site("W#p", invoice), site("W#p", null)]);
    expect(agreedCallerParamTypes(evidence)).toEqual({ "W#p": { record: invoice } });
  });

  it("one typed caller among more untyped ones types nothing, and reports them", () => {
    const evidence = foldCallerParamTypes([site("W#p", invoice), site("W#p", null), site("W#p", null)]);
    expect(agreedCallerParamTypes(evidence)).toEqual({});
    expect(evidence["W#p"].record).toMatchObject({ typedCallers: 1, untypedCallers: 2 });
  });

  it("a union-typed argument never types a parameter", () => {
    const union: TypeRef = { form: "union", members: [invoice, client] };
    const evidence = foldCallerParamTypes([
      { target: "W#p", params: new Map<string, TypeRef | null>([["record", union]]) },
    ]);
    expect(agreedCallerParamTypes(evidence)).toEqual({});
  });
});

describe("changedCallerParamTargets (2m83f.44)", () => {
  it("names callees whose typed parameters were added, removed or retyped, sorted", () => {
    expect(
      changedCallerParamTargets(
        { "B#p": { record: invoice }, "C#p": { record: invoice }, "D#p": { record: invoice } },
        { "A#p": { record: invoice }, "C#p": { record: client }, "D#p": { record: invoice } },
      ),
    ).toEqual(["A#p", "B#p", "C#p"]);
  });
});
