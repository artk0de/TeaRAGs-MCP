import { describe, expect, it } from "vitest";

import { buildHandleMap } from "../../scripts/resolve-author-handles.js";

// The release job runs this against the GitHub API; the lookup is injected so
// the unit test stays offline. A lookup answers { email, login } for a commit
// sha, or null when GitHub cannot attribute the commit to an account.
const commit = (hash: string) => ({ hash, subject: "feat: x", author: { name: "n", email: "e" }, body: "" });

describe("buildHandleMap", () => {
  it("maps each commit author's email to the GitHub login of the account", async () => {
    const lookup = async (hash: string) =>
      hash === "aaa1111" ? { email: "avl@logvinov.com", login: "incubus" } : null;

    expect(await buildHandleMap([commit("aaa1111")], lookup)).toEqual({ "avl@logvinov.com": "incubus" });
  });

  it("looks a commit up once per distinct sha", async () => {
    const seen: string[] = [];
    const lookup = async (hash: string) => {
      seen.push(hash);
      return { email: "avl@logvinov.com", login: "incubus" };
    };

    await buildHandleMap([commit("aaa1111"), commit("aaa1111"), commit("bbb2222")], lookup);

    expect(seen).toEqual(["aaa1111", "bbb2222"]);
  });

  it("keys the map by the lowercased email so the renderer matches git's casing", async () => {
    const lookup = async () => ({ email: "AVL@Logvinov.com", login: "incubus" });

    expect(await buildHandleMap([commit("aaa1111")], lookup)).toEqual({ "avl@logvinov.com": "incubus" });
  });

  it("omits a commit GitHub cannot attribute to an account", async () => {
    const lookup = async () => null;

    expect(await buildHandleMap([commit("aaa1111")], lookup)).toEqual({});
  });

  it("keeps the handles it did resolve when one lookup fails", async () => {
    const lookup = async (hash: string) => {
      if (hash === "aaa1111") throw new Error("HTTP 403");
      return { email: "avl@logvinov.com", login: "incubus" };
    };

    expect(await buildHandleMap([commit("aaa1111"), commit("bbb2222")], lookup)).toEqual({
      "avl@logvinov.com": "incubus",
    });
  });
});
