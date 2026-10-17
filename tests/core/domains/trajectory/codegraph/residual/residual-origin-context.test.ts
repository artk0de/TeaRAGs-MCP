import { describe, expect, it } from "vitest";

import {
  estimateStateTokens,
  receiverOriginSection,
} from "../../../../../../src/core/domains/trajectory/codegraph/residual/residual-origin-context.js";

/** A Ruby file, 1-based line i = FILE[i - 1]. */
const FILE = [
  "class Billing::Settle", // 1
  "  def initialize(firm)", // 2
  "    @firm = firm", // 3
  "    @chat_thread = Communication::Chat::Channel.find(firm.channel_id)", // 4
  "  end", // 5
  "", // 6
  "  def call(amount)", // 7
  "    total = 0", // 8
  "    bills_to_settle.each do |invoice|", // 9
  "      total += invoice.amount", // 10
  "    end", // 11
  "    payer = resolve_payer", // 12
  "    payer.charge(total)", // 13
  "    @chat_thread.post(amount)", // 14
  "    amount.round", // 15
  "  end", // 16
  "", // 17
  "  private", // 18
  "", // 19
  "  def bills_to_settle", // 20
  "    GettingPaid::Bill.where(firm: @firm).unpaid", // 21
  "  end", // 22
  "", // 23
  "  def resolve_payer", // 24
  "    @firm.payers.first", // 25
  "  end", // 26
  "end", // 27
].join("\n");

const METHOD = { methodStartLine: 7, methodEndLine: 16 };
const wholeMethod = (line: number) => line >= 7 && line <= 16;

function section(receivers: string[], visible: (line: number) => boolean = wholeMethod, maxTokens = 400): string {
  return receiverOriginSection({ fileText: FILE, ...METHOD, visibleLines: visible, receivers, maxTokens });
}

describe("receiverOriginSection", () => {
  it("shows where an ivar is assigned elsewhere in the class", () => {
    const out = section(["@chat_thread"]);

    expect(out).toContain("@chat_thread = Communication::Chat::Channel.find(firm.channel_id)");
    expect(out).not.toContain("def call");
  });

  it("shows the head of the project method a block parameter iterates over", () => {
    const out = section(["invoice"]);

    expect(out).toContain("def bills_to_settle");
    expect(out).toContain("GettingPaid::Bill.where(firm: @firm).unpaid");
    expect(out).not.toContain("def resolve_payer");
  });

  it("shows the head of the project method a local is assigned from", () => {
    const out = section(["payer"]);

    expect(out).toContain("def resolve_payer");
    expect(out).toContain("@firm.payers.first");
  });

  it("repeats no assignment line the state already shows, and adds it when the window cut it", () => {
    const shown = section(["payer"]);
    const windowed = section(["payer"], (line) => line === 7 || line === 13);

    expect(shown).not.toContain("payer = resolve_payer");
    expect(windowed).toContain("payer = resolve_payer");
  });

  it("names nothing for a method parameter, a constant or self", () => {
    expect(section(["amount", "Firm", "self.class"])).toBe("");
  });

  it("drops entries that do not fit the token budget, and the whole section when none fits", () => {
    expect(section(["@chat_thread", "invoice", "payer"], wholeMethod, 5)).toBe("");
    const tight = section(["@chat_thread", "invoice"], wholeMethod, estimateStateTokens(section(["@chat_thread"])));
    expect(tight).toContain("@chat_thread =");
    expect(tight).not.toContain("def bills_to_settle");
  });

  it("follows the chain head of a receiver chain", () => {
    expect(section(["@chat_thread.owner"])).toContain("@chat_thread = Communication::Chat::Channel");
  });
});
