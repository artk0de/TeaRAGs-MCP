/**
 * A type name's head before a trailing prepositional complement: `ObjectsForFirm`
 * names objects, not a firm. Connector words are a closed grammatical class
 * (prepositions / conjunctions), a connector only in an INTERIOR position; the
 * last word stays the head when the project uses it as a role word in names
 * with no connector (`BatchMarkAsReadWorker` is a worker).
 */
import { describe, expect, it } from "vitest";

import { splitNameSlots, typeNameParts } from "../../../../../src/core/domains/explore/naming-lexicon/name-slots.js";
import {
  deriveTypeRoles,
  typeNameParser,
  type TypeNameRow,
} from "../../../../../src/core/domains/explore/naming-lexicon/type-roles.js";
import {
  judgeTypeDraft,
  typeDraftMeaningPairs,
  typeNameEvidence,
} from "../../../../../src/core/domains/explore/naming-lexicon/verdicts.js";

const row = (shortName: string, relPath: string, ancestors: string[] = []): TypeNameRow => ({
  symbolId: shortName,
  relPath,
  shortName,
  symbolKind: "class",
  ancestors,
});

describe("typeNameParts", () => {
  it("heads a name by the word before its first interior connector; the rest is a complement", () => {
    expect(typeNameParts("Supporting::ActivityFeed::Queries::ObjectsForFirm")).toEqual({
      words: ["objects", "for", "firm"],
      qualifiers: [],
      head: "objects",
      connector: "for",
      complement: ["firm"],
    });
  });

  it("reads snake_case and camelCase alike", () => {
    expect(typeNameParts("objects_for_firm").head).toBe("objects");
    expect(typeNameParts("activeObjectsByFirmId")).toMatchObject({
      qualifiers: ["active"],
      head: "objects",
      connector: "by",
      complement: ["firm", "id"],
    });
  });

  it("splits at the FIRST connector only", () => {
    expect(typeNameParts("SnapshotMigrationFromV1ToV2")).toMatchObject({
      qualifiers: ["snapshot"],
      head: "migration",
      connector: "from",
      complement: ["v1", "to", "v2"],
    });
  });

  it("a connector word at the start or the end of a name is no connector", () => {
    expect(typeNameParts("SignIn")).toMatchObject({ head: "in", qualifiers: ["sign"], complement: [] });
    expect(typeNameParts("GroupBy").head).toBe("by");
    expect(typeNameParts("WithRouter")).toMatchObject({ head: "router", qualifiers: ["with"], complement: [] });
  });

  it("a conjunction coordinates inside the compound, and a partitive `of` precedes its head: no connector", () => {
    expect(typeNameParts("CardAndBankPaymentMethodType")).toMatchObject({ head: "type", complement: [] });
    expect(typeNameParts("FindOrCreate")).toMatchObject({ head: "create", complement: [] });
    expect(typeNameParts("KindOfService")).toMatchObject({ head: "service", complement: [] });
  });

  it("a word outside the closed class is never a connector", () => {
    expect(typeNameParts("ClientUploadedDocument")).toMatchObject({
      head: "document",
      qualifiers: ["client", "uploaded"],
      complement: [],
    });
  });

  it("keeps the last word as the head when it is one of the given role words", () => {
    expect(typeNameParts("BatchMarkAsReadWorker", new Set(["worker"]))).toEqual({
      words: ["batch", "mark", "as", "read", "worker"],
      qualifiers: ["batch", "mark", "as", "read"],
      head: "worker",
      complement: [],
    });
  });
});

describe("splitNameSlots with a complement", () => {
  it("finds the known head phrase inside the part before the connector and reports the complement", () => {
    expect(splitNameSlots("CachedFileSignalsForChunk", new Set(["file signals"]))).toEqual({
      head: ["file", "signals"],
      qualifiers: ["cached"],
      complement: ["chunk"],
    });
  });
});

/** taxdome's `activity_feed/queries/`: five `*ForFirm` queries beside a helper and a value object. */
const QUERIES = [
  row("AccountsForFirm", "app/queries/accounts_for_firm.rb"),
  row("ActorsForFirm", "app/queries/actors_for_firm.rb"),
  row("EventForFirm", "app/queries/event_for_firm.rb"),
  row("EventsForFirm", "app/queries/events_for_firm.rb"),
  row("ObjectsForFirm", "app/queries/objects_for_firm.rb"),
  row("CursorHelper", "app/queries/cursor_helper.rb"),
  row("Meta", "app/queries/meta.rb"),
  row("Firm", "app/models/firm.rb"),
  row("CurrentFirm", "app/lib/current_firm.rb"),
];

const WORKERS = [
  row("SyncWorker", "app/workers/sync_worker.rb"),
  row("CleanupWorker", "app/workers/cleanup_worker.rb"),
  row("ExportWorker", "app/workers/export_worker.rb"),
  row("BatchMarkAsReadWorker", "app/workers/batch_mark_as_read_worker.rb"),
  row("DeliverNotificationToCandidatesWorker", "app/workers/deliver_notification_to_candidates_worker.rb"),
];

describe("typeNameParser — role words from names with no connector", () => {
  it("a last word the connector-free names carry as a role stays the head", () => {
    const parse = typeNameParser(WORKERS);
    expect(parse("DeliverNotificationToCandidatesWorker").head).toBe("worker");
  });

  it("a last word no connector-free family carries is a complement", () => {
    const parse = typeNameParser([...QUERIES, ...WORKERS]);
    expect(parse("ObjectsForFirm").head).toBe("objects");
  });

  it("a project suffix alone is no family kind: an entity noun stays a complement", () => {
    // `firm` is a project suffix of connector-free names (three qualified `*Firm`s in three
    // directories) — the evidence a bare entity noun earns, not what makes a word a kind.
    const firms = [
      row("CurrentFirm", "app/lib/current_firm.rb"),
      row("DemoFirm", "app/demo/demo_firm.rb"),
      row("ArchivedFirm", "app/archive/archived_firm.rb"),
    ];
    expect(deriveTypeRoles(firms)).toContainEqual(expect.objectContaining({ role: "firm", evidence: "projectSuffix" }));
    expect(typeNameParser([...firms, ...QUERIES])("ObjectsForFirm").head).toBe("objects");
  });
});

describe("deriveTypeRoles — a prepositional complement is not the head", () => {
  it("`ObjectsForFirm` carries no `firm` role, from its directory or as a project suffix", () => {
    const roles = deriveTypeRoles(QUERIES).filter((assignment) => assignment.symbolId === "ObjectsForFirm");
    expect(roles.map((assignment) => assignment.role)).not.toContain("firm");
  });

  it("a connector name ending in its family's role word keeps the role", () => {
    const roles = deriveTypeRoles(WORKERS).filter((assignment) => assignment.symbolId === "BatchMarkAsReadWorker");
    expect(roles).toContainEqual(expect.objectContaining({ role: "worker", evidence: "directory" }));
  });
});

describe("typeDraftMeaningPairs — a connector is grammar, never a word to replace", () => {
  it("compares the draft's head and complement with a directory word, never its connector", () => {
    const pairs = typeDraftMeaningPairs(
      { name: "ObjectsForClient", path: "app/lib/supporting/queries/objects_for_client.rb" },
      typeNameEvidence(QUERIES, "type"),
      ["SupportingQuery"],
    );
    expect(pairs).toContainEqual(["objects", "supporting"]);
    expect(pairs.flat()).not.toContain("for");
  });
});

describe("judgeTypeDraft — the complement neither sets nor misses the role", () => {
  it("`ObjectsForClient` beside the `*ForFirm` queries is no MISFIT naming `firm`", () => {
    const verdict = judgeTypeDraft({
      name: "ObjectsForClient",
      path: "app/queries/objects_for_client.rb",
      casing: "pascal",
      evidence: typeNameEvidence(QUERIES, "type"),
      conceptNames: [],
    });
    expect(verdict.verdict).not.toBe("MISFIT");
  });

  it("a directory role missing from the head is inserted before the complement", () => {
    const finders = [
      row("ObjectsFinder", "app/finders/objects_finder.rb"),
      row("EventsFinder", "app/finders/events_finder.rb"),
      row("AccountsFinder", "app/finders/accounts_finder.rb"),
    ];
    const judge = (name: string) =>
      judgeTypeDraft({
        name,
        path: "app/finders/new.rb",
        casing: "pascal",
        evidence: typeNameEvidence(finders, "type"),
        conceptNames: [],
      });
    expect(judge("ObjectsForClient")).toMatchObject({ verdict: "MISFIT", suggestion: "ObjectsFinderForClient" });
    expect(judge("ObjectsFinderForClient").verdict).not.toBe("MISFIT");
  });
});
