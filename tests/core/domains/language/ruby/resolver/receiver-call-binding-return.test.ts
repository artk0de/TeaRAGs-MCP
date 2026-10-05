/**
 * A local bound to a call WITH a receiver reads that receiver's return fact,
 * never a namesake's (bd tea-rags-mcp-0qaht.56).
 *
 *     account = ActivityPub::FetchRemoteAccountService.new.call(uri)
 *     account.nil?
 *
 * `localCallBindings` keeps only the outermost method of a chained right-hand
 * side (`call`), the same spelling a receiver-less `call(uri)` records — and
 * the bare spelling reads the flat, owner-less `functionReturnTypes` map, where
 * mastodon's one `# @return [Favourite]` on `FavouriteService#call` spoke for
 * every `.call` in the corpus. The receiver is written in the source, so when
 * its type is known it decides: the answer comes from ITS class's return
 * channels, or there is none. A receiver nothing types, and a receiver-less
 * call (which dispatches on `self`), read exactly as before.
 */
import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import { CONTINUE } from "../../../../../../src/core/contracts/resolution.js";
import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type CallRef,
  type ChunkExtraction,
  type SymbolDefinition,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import type { RubyTypeRef } from "../../../../../../src/core/contracts/types/language.js";
import { RubyReturnTypeBindingSymbolResolutionStrategy } from "../../../../../../src/core/domains/language/ruby/resolver/strategies/index.js";
import { boundCallReturnType } from "../../../../../../src/core/domains/language/ruby/resolver/type-propagation.js";
import { extractFromRubyFile } from "../../../../../../src/core/domains/language/ruby/walker/walker.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function parse(src: string) {
  const parser = new Parser();
  parser.setLanguage(RbLang);
  return parser.parse(src);
}

const sym = (symbolId: string, shortName: string, relPath: string, scope: string[]): SymbolDefinition => ({
  symbolId,
  fqName: symbolId,
  shortName,
  relPath,
  scope,
});

const symbolTable = (() => {
  const t = new InMemoryGlobalSymbolTable();
  t.upsertFile("app/models/favourite.rb", [
    sym("Favourite", "Favourite", "app/models/favourite.rb", []),
    sym("Favourite#nil?", "nil?", "app/models/favourite.rb", ["Favourite"]),
  ]);
  t.upsertFile("app/models/account.rb", [
    sym("Account", "Account", "app/models/account.rb", []),
    sym("Account#also_known_as", "also_known_as", "app/models/account.rb", ["Account"]),
  ]);
  t.upsertFile("app/services/favourite_service.rb", [
    sym("FavouriteService", "FavouriteService", "app/services/favourite_service.rb", []),
    sym("FavouriteService#call", "call", "app/services/favourite_service.rb", ["FavouriteService"]),
  ]);
  t.upsertFile("app/services/activitypub/fetch_remote_account_service.rb", [
    sym(
      "ActivityPub::FetchRemoteAccountService",
      "FetchRemoteAccountService",
      "app/services/activitypub/fetch_remote_account_service.rb",
      ["ActivityPub"],
    ),
    sym(
      "ActivityPub::FetchRemoteAccountService#call",
      "call",
      "app/services/activitypub/fetch_remote_account_service.rb",
      ["ActivityPub", "FetchRemoteAccountService"],
    ),
  ]);
  t.upsertFile("app/services/resolve_account_service.rb", [
    sym("ResolveAccountService", "ResolveAccountService", "app/services/resolve_account_service.rb", []),
    sym("ResolveAccountService#call", "call", "app/services/resolve_account_service.rb", ["ResolveAccountService"]),
  ]);
  return t;
})();

/** `# @return [Favourite]` on `FavouriteService#call`, as the run-global maps carry it. */
const FLAT_RETURNS = { call: "Favourite", accounts: "Account" };
const STRUCTURED_RETURNS: Record<string, RubyTypeRef> = {
  "FavouriteService#call": { form: "instance", name: "Favourite" },
  "ResolveAccountService#call": { form: "instance", name: "Account" },
  "ResolveAccountService#accounts": { form: "container", element: { form: "instance", name: "Account" } },
};

function chunkOf(src: string, startLine: number, endLine: number): ChunkExtraction {
  const extraction = extractFromRubyFile({
    tree: parse(src),
    code: src,
    relPath: "app/lib/mover.rb",
    language: "ruby",
    chunks: [{ symbolId: "Mover#move", startLine, endLine, scope: ["Mover"] }],
  });
  const chunk = extraction.chunks[0];
  if (chunk === undefined) throw new Error("walker produced no chunk");
  return chunk;
}

function contextFor(chunk: ChunkExtraction): CallContext {
  return {
    callerFile: "app/lib/mover.rb",
    callerScope: ["Mover"],
    callerSymbolId: "Mover#move",
    imports: [],
    symbolTable,
    localBindings: chunk.localBindings,
    localCallBindings: chunk.localCallBindings,
    callResultBindings: chunk.callResultBindings,
    functionReturnTypes: FLAT_RETURNS,
    structuredReturnTypes: STRUCTURED_RETURNS,
  };
}

function siteOf(chunk: ChunkExtraction, callText: string, line: number): CallRef {
  const site = chunk.calls.find((c) => c.callText === callText && c.startLine === line);
  if (site === undefined) throw new Error(`walker emitted no call ${callText} on line ${line}`);
  return site;
}

const returnBinding = new RubyReturnTypeBindingSymbolResolutionStrategy({ mode: DEFAULT_AMBIGUOUS_RESOLVE_MODE });

const SRC = [
  "class Mover",
  "  def move(uri, acct, url)",
  "    target = ActivityPub::FetchRemoteAccountService.new.call(uri)",
  "    target.nil?",
  "    account = ResolveAccountService.new.call(acct)",
  "    account.also_known_as",
  "    service = ActivityPub::FetchRemoteAccountService.new",
  "    embed = service.call(url)",
  "    embed.nil?",
  "    opaque = remote_client.lookup.call(url)",
  "    opaque.nil?",
  "    own = call(url)",
  "    own.nil?",
  "    listed = ResolveAccountService.new.accounts(acct)",
  "    listed.nil?",
  "  end",
  "end",
].join("\n");

describe("a call binding WITH a receiver reads the receiver's return (0qaht.56)", () => {
  const chunk = chunkOf(SRC, 2, 16);
  const ctx = contextFor(chunk);

  it("records the chained right-hand side under the bare `call` spelling", () => {
    expect(chunk.localCallBindings?.target).toBe("call");
    expect(chunk.localCallBindings?.embed).toBe("call");
  });

  it("a known receiver whose `call` declares nothing is no type — never the namesake's Favourite", () => {
    expect(boundCallReturnType("target", ctx, siteOf(chunk, "target.nil?", 4))).toBeUndefined();
    expect(returnBinding.attempt(siteOf(chunk, "target.nil?", 4), ctx)).toBe(CONTINUE);
  });

  it("a known receiver reads its OWN class's return fact", () => {
    expect(boundCallReturnType("account", ctx, siteOf(chunk, "account.also_known_as", 6))).toEqual({
      form: "instance",
      name: "Account",
    });
  });

  it("a local typed by the walker types the receiver the same way", () => {
    expect(boundCallReturnType("embed", ctx, siteOf(chunk, "embed.nil?", 9))).toBeUndefined();
  });

  it("a receiver no channel can type keeps the bare reading, exactly as before", () => {
    expect(boundCallReturnType("opaque", ctx, siteOf(chunk, "opaque.nil?", 11))).toEqual({
      form: "instance",
      name: "Favourite",
    });
  });

  it("a receiver-less call still dispatches on self and reads the flat map as before", () => {
    expect(boundCallReturnType("own", ctx, siteOf(chunk, "own.nil?", 13))).toEqual({
      form: "instance",
      name: "Favourite",
    });
  });

  it("a relation answer the single-target reader cannot pin keeps the bare reading", () => {
    expect(boundCallReturnType("listed", ctx, siteOf(chunk, "listed.nil?", 15))).toEqual({
      form: "instance",
      name: "Account",
    });
  });
});
