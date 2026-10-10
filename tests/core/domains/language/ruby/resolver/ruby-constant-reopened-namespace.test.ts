/**
 * A Rails constant whose namespace nested files REOPEN (bd
 * tea-rags-mcp-r8hme.52.12).
 *
 * `Supporting::ActivityFeed::Api` is defined in `.../activity_feed/api.rb`
 * (module_function methods) and reopened as `module Api` by every file under
 * `.../activity_feed/api/contracts/**`. Each of those files declares the
 * constant too, so the qualified symbol lookup sees several declarers and the
 * `=== 1` gate in `resolveConstant` gave up; the Zeitwerk pass only ranges over
 * the caller's require texts, so the defining file was never a candidate. The
 * caller lost both its file edge and its call edge.
 *
 * Narrowing rule under test: among several Ruby declarers, the one at the
 * Zeitwerk-conventional path DEFINES the constant, the rest reopen it. Exactly
 * one conventional declarer resolves; zero or several keep today's behaviour.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type CallRef,
  type SymbolDefinition,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import {
  RubyConstantSymbolResolutionStrategy,
  type ResolverConfig,
} from "../../../../../../src/core/domains/language/ruby/resolver/strategies/index.js";
import { resolveConstant } from "../../../../../../src/core/domains/language/ruby/resolver/strategies/shared.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const cfg: ResolverConfig = { mode: DEFAULT_AMBIGUOUS_RESOLVE_MODE };

const sym = (symbolId: string, shortName: string, relPath: string, scope: string[]): SymbolDefinition => ({
  symbolId,
  fqName: symbolId,
  shortName,
  relPath,
  scope,
});

const tableWith = (...files: [string, SymbolDefinition[]][]): InMemoryGlobalSymbolTable => {
  const t = new InMemoryGlobalSymbolTable();
  for (const [relPath, defs] of files) t.upsertFile(relPath, defs);
  return t;
};

const ctx = (over: Partial<CallContext> & Pick<CallContext, "symbolTable">): CallContext => ({
  callerFile: "app/services/crm/invitation_accept.rb",
  callerScope: [],
  imports: [],
  ...over,
});

const API = "app/services/acme/api.rb";
const REQUEST = "app/services/acme/api/contracts/x/request.rb";
const RESPONSE = "app/services/acme/api/contracts/x/response.rb";

/** The definer: `module Acme; module Api; module_function; def send_event`. */
const definer = (relPath = API): [string, SymbolDefinition[]] => [
  relPath,
  [
    sym("Acme", "Acme", relPath, []),
    sym("Acme::Api", "Api", relPath, ["Acme"]),
    sym("Acme::Api.send_event", "send_event", relPath, ["Acme", "Api"]),
    sym("Acme::Api#send_event", "send_event", relPath, ["Acme", "Api"]),
  ],
];

/** A reopener: `module Acme; module Api; module Contracts; module X; class <Leaf>`. */
const reopener = (relPath: string, leaf: string): [string, SymbolDefinition[]] => [
  relPath,
  [
    sym("Acme", "Acme", relPath, []),
    sym("Acme::Api", "Api", relPath, ["Acme"]),
    sym("Acme::Api::Contracts", "Contracts", relPath, ["Acme", "Api"]),
    sym("Acme::Api::Contracts::X", "X", relPath, ["Acme", "Api", "Contracts"]),
    sym(`Acme::Api::Contracts::X::${leaf}`, leaf, relPath, ["Acme", "Api", "Contracts", "X"]),
  ],
];

const sendEvent: CallRef = {
  callText: "Acme::Api.send_event(:x)",
  receiver: "Acme::Api",
  member: "send_event",
  startLine: 1,
};

describe("resolveConstant — namespace reopened by nested files (r8hme.52.12)", () => {
  it("resolves the qualified constant to the file at its conventional path", () => {
    const symbolTable = tableWith(definer(), reopener(REQUEST, "Request"), reopener(RESPONSE, "Response"));
    expect(resolveConstant("Acme::Api", ctx({ symbolTable }))).toBe(API);
  });

  it("narrows the enclosing-scope probe the same way", () => {
    const symbolTable = tableWith(definer(), reopener(REQUEST, "Request"));
    const caller = ctx({ symbolTable, callerFile: "app/services/acme/notifier.rb", callerScope: ["Acme", "Notifier"] });
    expect(resolveConstant("Api", caller)).toBe(API);
  });

  it("stays unresolved when no declarer sits at the conventional path (unchanged)", () => {
    const symbolTable = tableWith(
      reopener("app/services/acme/foo/request.rb", "Request"),
      reopener("app/services/acme/bar/response.rb", "Response"),
    );
    expect(resolveConstant("Acme::Api", ctx({ symbolTable }))).toBeNull();
  });

  // Two declarers at conventional paths under different autoload roots is a
  // Zeitwerk shadowing question: the app's real `autoload_paths` order decides
  // which file wins, and the resolver does not know it. DEFAULT_AUTOLOAD_ROOTS
  // is a guess at that order, good enough to pick a file among a caller's own
  // require texts but not to choose between two genuine definers. Today's
  // contract for several declarers is "no answer"; it stays that way.
  it("stays unresolved when declarers sit at conventional paths under two autoload roots (unchanged)", () => {
    const symbolTable = tableWith(definer("app/models/acme/api.rb"), definer("lib/acme/api.rb"));
    expect(resolveConstant("Acme::Api", ctx({ symbolTable }))).toBeNull();
  });
});

describe("constant strategy — call into a reopened namespace (r8hme.52.12)", () => {
  it("pins the module_function method in the defining file", () => {
    const symbolTable = tableWith(definer(), reopener(REQUEST, "Request"), reopener(RESPONSE, "Response"));
    const outcome = new RubyConstantSymbolResolutionStrategy(cfg).attempt(sendEvent, ctx({ symbolTable }));
    expect(outcome.kind === "resolved" ? outcome.target : null).toEqual({
      targetRelPath: API,
      targetSymbolId: "Acme::Api.send_event",
    });
  });
});
