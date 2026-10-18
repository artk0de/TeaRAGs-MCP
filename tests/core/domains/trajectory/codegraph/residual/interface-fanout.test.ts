import { describe, expect, it } from "vitest";

import type { InheritanceEdge } from "../../../../../../src/core/contracts/types/codegraph-hierarchy.js";
import {
  fanoutCandidates,
  GraphClassTieReader,
  interfaceFanout,
  polymorphicAsNames,
  type ClassTies,
} from "../../../../../../src/core/domains/trajectory/codegraph/residual/interface-fanout.js";

const ties = (entries: Record<string, string[]>): ClassTies =>
  new Map(Object.entries(entries).map(([cls, keys]) => [cls, new Set(keys)]));

const MENU = ["Alpha", "Beta", "Gamma", "Delta"];

describe("fanoutCandidates", () => {
  it("keeps the menu classes at or above the floor, in menu order, never the none option", () => {
    expect(fanoutCandidates(MENU, { Beta: 0.5, Alpha: 0.3, Gamma: 0.1, "(none)": 0.1 }, 0.15)).toEqual([
      "Alpha",
      "Beta",
    ]);
  });
});

describe("interfaceFanout", () => {
  const base = { menu: MENU, floor: 0.15, accept: 0.7 };

  it("fans a receiver named after a polymorphic interface out over the classes declaring it", () => {
    const fanout = interfaceFanout({
      ...base,
      receiverText: "@actor",
      probabilities: { Beta: 0.55, Delta: 0.35, Alpha: 0.1 },
      ties: ties({ Beta: ["as:actor"], Delta: ["as:actor", "as:owner"] }),
    });

    expect(fanout).toEqual({ classes: ["Beta", "Delta"], p: 0.9, via: "polymorphic" });
  });

  it("reads the interface name off the last hop of a chain receiver", () => {
    const fanout = interfaceFanout({
      ...base,
      receiverText: "task.actor",
      probabilities: { Beta: 0.5, Delta: 0.4 },
      ties: ties({ Beta: ["as:actor"], Delta: ["as:actor"] }),
    });

    expect(fanout?.classes).toEqual(["Beta", "Delta"]);
  });

  it("does not fan out when the polymorphic interface holds one of the likely classes", () => {
    const fanout = interfaceFanout({
      ...base,
      receiverText: "actor",
      probabilities: { Beta: 0.5, Delta: 0.4 },
      ties: ties({ Beta: ["as:actor", "super:Person"], Delta: ["super:Person"] }),
    });

    expect(fanout).toBeUndefined();
  });

  it("fans out over likely classes sharing a structural tie when the receiver names no interface", () => {
    const fanout = interfaceFanout({
      ...base,
      receiverText: "subscription",
      probabilities: { Alpha: 0.6, Gamma: 0.3 },
      ties: ties({ Alpha: ["super:Plan", "include:Billable"], Gamma: ["super:Plan"] }),
    });

    expect(fanout).toEqual({ classes: ["Alpha", "Gamma"], p: 0.9, via: "shared" });
  });

  it("never fans out over likely classes that share no tie", () => {
    const fanout = interfaceFanout({
      ...base,
      receiverText: "record",
      probabilities: { Alpha: 0.5, Gamma: 0.4 },
      ties: ties({ Alpha: ["super:Plan"], Gamma: ["include:Billable"] }),
    });

    expect(fanout).toBeUndefined();
  });

  it("does not fan out when the summed p stays under the accept threshold", () => {
    const fanout = interfaceFanout({
      ...base,
      receiverText: "actor",
      probabilities: { Beta: 0.35, Delta: 0.3, "(none)": 0.35 },
      ties: ties({ Beta: ["as:actor"], Delta: ["as:actor"] }),
    });

    expect(fanout).toBeUndefined();
  });

  it("does not fan out a single likely class", () => {
    const fanout = interfaceFanout({
      ...base,
      receiverText: "actor",
      probabilities: { Beta: 0.9, Delta: 0.05 },
      ties: ties({ Beta: ["as:actor"], Delta: ["as:actor"] }),
    });

    expect(fanout).toBeUndefined();
  });
});

describe("polymorphicAsNames", () => {
  it("reads the `as:` name of every has_many / has_one, both hash spellings", () => {
    const source = [
      "class Person < Base",
      "  has_many :tasks, as: :actor, dependent: :destroy",
      "  has_one :avatar, :as => :owner",
      "  belongs_to :team",
      "  # has_many :notes, as: :commented",
      "end",
    ].join("\n");

    expect(polymorphicAsNames(source)).toEqual(["actor", "owner"]);
  });
});

describe("GraphClassTieReader", () => {
  const edge = (source: string, ancestor: string, kind: InheritanceEdge["kind"], project = true): InheritanceEdge => ({
    sourceFqName: source,
    ancestorFqName: ancestor,
    ancestorSymbolId: project ? ancestor : null,
    kind,
    depth: 1,
  });
  const supertypes: Record<string, InheritanceEdge[]> = {
    Alpha: [
      edge("Alpha", "Person", "super"),
      edge("Alpha", "Billable", "include"),
      edge("Alpha", "Ext", "include", false),
    ],
    Person: [edge("Person", "AppRecord", "super")],
    AppRecord: [edge("AppRecord", "Framework::Base", "super", false)],
    Beta: [edge("Beta", "AppRecord", "super")],
  };
  const files: Record<string, string> = {
    "app/alpha.rb": "class Alpha < Person\n  has_many :tasks, as: :actor\nend\n",
    "app/beta.rb": "class Beta < AppRecord\nend\n",
  };
  const paths: Record<string, string[]> = { Alpha: ["app/alpha.rb"], Beta: ["app/beta.rb"] };

  it("ties a class to its polymorphic names, project includes and project superclasses below the base", async () => {
    const reads: string[] = [];
    const reader = new GraphClassTieReader(
      {
        getSupertypes: async (fq) => supertypes[fq] ?? [],
        getSymbolRelPaths: async (ids) => new Map(ids.map((id) => [id, paths[id] ?? []])),
      },
      async (relPath) => {
        reads.push(relPath);
        return files[relPath] ?? "";
      },
    );

    const result = await reader.tiesOf(["Alpha", "Beta"]);
    await reader.tiesOf(["Alpha"]);

    expect([...(result.get("Alpha") ?? [])].sort()).toEqual(["as:actor", "include:Billable", "super:Person"]);
    expect([...(result.get("Beta") ?? [])]).toEqual([]);
    expect(reads).toEqual(["app/alpha.rb", "app/beta.rb"]);
  });
});
