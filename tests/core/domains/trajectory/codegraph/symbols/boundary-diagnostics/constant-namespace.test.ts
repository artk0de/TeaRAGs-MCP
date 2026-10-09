/**
 * The component tree (bd tea-rags-mcp-bvcg4): a component's ancestry is its
 * own tree's chain — a directory nests by path, a constant namespace by
 * constant path — and the two trees never share a node.
 */

import { describe, expect, it } from "vitest";

import { componentAncestry } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/boundary-diagnostics/index.js";

describe("componentAncestry", () => {
  it("lists a directory component's enclosing directories, outermost first, itself last", () => {
    expect(componentAncestry("app/pages/Checkout")).toEqual(["app", "app/pages", "app/pages/Checkout"]);
  });

  it("lists a namespace component's enclosing namespaces by constant path", () => {
    expect(componentAncestry("::Billing::Api::V1")).toEqual(["::Billing", "::Billing::Api", "::Billing::Api::V1"]);
  });

  it("gives the repository root no ancestry — it is no feature of anything", () => {
    expect(componentAncestry("")).toEqual([]);
  });

  it("keeps a namespace and a same-named directory in different trees", () => {
    const namespace = new Set(componentAncestry("::Billing::Charges"));
    expect(componentAncestry("billing/charges").some((node) => namespace.has(node))).toBe(false);
  });
});
