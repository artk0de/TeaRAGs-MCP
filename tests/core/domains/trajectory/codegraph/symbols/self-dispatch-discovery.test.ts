/**
 * bd tea-rags-mcp-dt9l3 (DEFECT 2a) — the interprocedural template→hook discovery
 * pre-pass. A method `M` in type `A` is a **self-dispatch template** when its body
 * reaches a hook `H` on `self` (bare `H` / `self.H` / `self.new.H` — all normalized
 * to the bare member) that `A` does NOT concretely define but a related concrete
 * type (subclass / includer / prepender / extender) DOES. Pure over an injected
 * probe so it is unit-testable free of provider internals.
 */
import { describe, expect, it } from "vitest";

import {
  discoverSelfDispatchTemplates,
  type SelfDispatchMethod,
  type SelfDispatchProbe,
} from "../../../../../../src/core/domains/trajectory/codegraph/symbols/self-dispatch-discovery.js";

/** Build a probe from two plain maps: type→concretely-defined members, type→related types. */
function probeOf(
  concrete: Record<string, readonly string[]>,
  related: Record<string, readonly string[]>,
): SelfDispatchProbe {
  return {
    definesConcretely: (type, member) => (concrete[type] ?? []).includes(member),
    relatedConcreteTypes: (type) => related[type] ?? [],
  };
}

describe("discoverSelfDispatchTemplates (DEFECT 2a)", () => {
  it("discovers the KindOfService `#call → perform` template (include channel, absent hook)", () => {
    const methods: SelfDispatchMethod[] = [
      { symbolId: "KindOfService#call", enclosingType: "KindOfService", selfHookCandidates: ["perform"] },
    ];
    // KindOfService defines no `perform`; includers Create / Refresh do.
    const probe = probeOf(
      { Create: ["perform"], Refresh: ["perform"] },
      { KindOfService: ["Create", "Refresh"] },
    );

    expect(discoverSelfDispatchTemplates(methods, probe)).toEqual([
      { templateSymbolId: "KindOfService#call", enclosingType: "KindOfService", hook: "perform" },
    ]);
  });

  it("treats an abstract STUB in A as not-concretely-defined (REDIRECT case: BaseProcessor)", () => {
    const methods: SelfDispatchMethod[] = [
      {
        symbolId: "BaseProcessor.process_result",
        enclosingType: "BaseProcessor",
        selfHookCandidates: ["process_result"],
      },
    ];
    // BaseProcessor#process_result exists but is a `raise NotImplementedError`
    // stub → probe reports it NOT concretely defined; a subclass defines it.
    const probe = probeOf({ Form1040SaProcessor: ["process_result"] }, { BaseProcessor: ["Form1040SaProcessor"] });

    expect(discoverSelfDispatchTemplates(methods, probe)).toEqual([
      { templateSymbolId: "BaseProcessor.process_result", enclosingType: "BaseProcessor", hook: "process_result" },
    ]);
  });

  it("does NOT flag a hook that A concretely defines itself (not a template)", () => {
    const methods: SelfDispatchMethod[] = [
      { symbolId: "Widget#render", enclosingType: "Widget", selfHookCandidates: ["draw"] },
    ];
    // Widget defines `draw` itself → the call resolves normally, not a self-dispatch template.
    const probe = probeOf({ Widget: ["draw"], FancyWidget: ["draw"] }, { Widget: ["FancyWidget"] });

    expect(discoverSelfDispatchTemplates(methods, probe)).toEqual([]);
  });

  it("does NOT flag a hook no related concrete type defines (genuine miss, not a hook)", () => {
    const methods: SelfDispatchMethod[] = [
      { symbolId: "Thing#go", enclosingType: "Thing", selfHookCandidates: ["nonexistent"] },
    ];
    const probe = probeOf({ SubThing: ["other"] }, { Thing: ["SubThing"] });

    expect(discoverSelfDispatchTemplates(methods, probe)).toEqual([]);
  });

  it("emits one template per (method, hook) when a template body reaches several hooks", () => {
    // BaseEvent#to_h self-calls `type` and `action` (Ruby-3.1 shorthand hash).
    const methods: SelfDispatchMethod[] = [
      { symbolId: "BaseEvent#to_h", enclosingType: "BaseEvent", selfHookCandidates: ["type", "action"] },
    ];
    const probe = probeOf({ LoginEvent: ["type", "action"] }, { BaseEvent: ["LoginEvent"] });

    expect(discoverSelfDispatchTemplates(methods, probe)).toEqual([
      { templateSymbolId: "BaseEvent#to_h", enclosingType: "BaseEvent", hook: "type" },
      { templateSymbolId: "BaseEvent#to_h", enclosingType: "BaseEvent", hook: "action" },
    ]);
  });

  it("works across any wiring channel — a prepender/extender is just another related concrete type", () => {
    const methods: SelfDispatchMethod[] = [
      { symbolId: "Timing#call", enclosingType: "Timing", selfHookCandidates: ["perform"] },
    ];
    // `Service prepend Timing` (or extend) — Service is the related concrete definer.
    const probe = probeOf({ Service: ["perform"] }, { Timing: ["Service"] });

    expect(discoverSelfDispatchTemplates(methods, probe)).toEqual([
      { templateSymbolId: "Timing#call", enclosingType: "Timing", hook: "perform" },
    ]);
  });
});
