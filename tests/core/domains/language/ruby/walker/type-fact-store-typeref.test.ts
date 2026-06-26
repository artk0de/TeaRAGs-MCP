/**
 * INFRA-A: LocalBinding.typeRef channel — RubyTypeFactStore sets typeRef for
 * union / container facts, preserving the existing `type` string for parity.
 */
import { describe, expect, it } from "vitest";

import { RubyTypeFactStore } from "../../../../../../src/core/domains/language/ruby/walker/type-fact-store.js";
import type { RubyTypeFact } from "../../../../../../src/core/domains/language/ruby/walker/type-sources/types.js";

describe("RubyTypeFactStore.localBindingsForChunk — typeRef channel (INFRA-A)", () => {
  // ── container: type string = element name (parity), typeRef = full ref ──────

  it("container param: type = element name (parity), typeRef = container ref", () => {
    const facts: RubyTypeFact[] = [
      {
        kind: "param",
        symbolScope: ["C"],
        methodName: "m",
        name: "posts",
        line: 3,
        type: { form: "container", element: { form: "instance", name: "Post" } },
      },
    ];
    const store = RubyTypeFactStore.fromFacts(facts);
    const bindings = store.localBindingsForChunk(1, 20);
    const b = bindings["posts"]?.[0];
    // Parity: type string unchanged (element name)
    expect(b?.type).toBe("Post");
    // Additive: typeRef carries the full container
    expect(b?.typeRef).toEqual({ form: "container", element: { form: "instance", name: "Post" } });
  });

  it("container local: valueKind absent (no change), typeRef present", () => {
    const store = RubyTypeFactStore.fromFacts([
      {
        kind: "local",
        symbolScope: [],
        name: "items",
        line: 5,
        type: { form: "container", element: { form: "instance", name: "Item" } },
      },
    ]);
    const b = store.localBindingsForChunk(1, 10)["items"]?.[0];
    expect(b?.type).toBe("Item"); // parity: element name
    expect(b?.typeRef).toEqual({ form: "container", element: { form: "instance", name: "Item" } });
    expect(b?.valueKind).toBeUndefined();
  });

  // ── union: previously dropped, now emitted with typeRef ─────────────────────

  it("union param: binding emitted with typeRef (additive — was previously dropped)", () => {
    const unionType = {
      form: "union" as const,
      members: [
        { form: "instance" as const, name: "A" },
        { form: "instance" as const, name: "B" },
      ],
    };
    const facts: RubyTypeFact[] = [
      {
        kind: "param",
        symbolScope: [],
        name: "obj",
        line: 7,
        type: unionType,
      },
    ];
    const store = RubyTypeFactStore.fromFacts(facts);
    const bindings = store.localBindingsForChunk(1, 20);
    const b = bindings["obj"]?.[0];
    // typeRef MUST carry the union
    expect(b?.typeRef).toEqual(unionType);
    // type string: best-effort (first in-project member name)
    expect(b?.type).toBe("A");
  });

  it("union local: binding emitted for both members, typeRef present", () => {
    const unionType = {
      form: "union" as const,
      members: [
        { form: "instance" as const, name: "User" },
        { form: "instance" as const, name: "Admin" },
      ],
    };
    const store = RubyTypeFactStore.fromFacts([
      { kind: "local", symbolScope: [], name: "actor", line: 10, type: unionType },
    ]);
    const b = store.localBindingsForChunk(1, 20)["actor"]?.[0];
    expect(b?.typeRef).toEqual(unionType);
    expect(typeof b?.type).toBe("string");
    expect((b?.type?.length ?? 0) > 0).toBe(true);
  });

  // ── class/instance: no typeRef (string suffices — parity unchanged) ─────────

  it("instance param: no typeRef (bare string is sufficient)", () => {
    const store = RubyTypeFactStore.fromFacts([
      { kind: "param", symbolScope: [], name: "user", line: 2, type: { form: "instance", name: "User" } },
    ]);
    const b = store.localBindingsForChunk(1, 10)["user"]?.[0];
    expect(b?.type).toBe("User");
    expect(b?.typeRef).toBeUndefined();
  });

  it("class param: valueKind=class, no typeRef", () => {
    const store = RubyTypeFactStore.fromFacts([
      { kind: "param", symbolScope: [], name: "klass", line: 2, type: { form: "class", name: "User" } },
    ]);
    const b = store.localBindingsForChunk(1, 10)["klass"]?.[0];
    expect(b?.type).toBe("User");
    expect(b?.valueKind).toBe("class");
    expect(b?.typeRef).toBeUndefined();
  });
});
