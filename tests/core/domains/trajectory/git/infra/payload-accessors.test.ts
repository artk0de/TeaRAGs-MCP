import { describe, expect, it } from "vitest";

import {
  chunkField,
  fileField,
  getGit,
  payloadAlpha,
} from "../../../../../../src/core/domains/trajectory/git/infra/payload-accessors.js";

const payload = (git: Record<string, unknown>) => ({ git }) as Record<string, unknown>;

describe("getGit", () => {
  it("returns the git object when present, undefined otherwise", () => {
    expect(getGit({ git: { file: {} } })).toEqual({ file: {} });
    expect(getGit({})).toBeUndefined();
    expect(getGit({ git: "not an object" })).toBeUndefined();
  });
});

describe("fileField — nested first, flat fallback", () => {
  it("reads the nested git.file shape when present", () => {
    expect(fileField(payload({ file: { lastModifiedAt: 5 }, lastModifiedAt: 99 }), "lastModifiedAt")).toBe(5);
  });

  it("falls back to the flat git shape when the nested key is absent", () => {
    expect(fileField(payload({ file: { commitCount: 3 }, lastModifiedAt: 99 }), "lastModifiedAt")).toBe(99);
    expect(fileField(payload({ lastModifiedAt: 99 }), "lastModifiedAt")).toBe(99);
  });

  it("is undefined when neither shape carries the field", () => {
    expect(fileField(payload({ file: { commitCount: 3 } }), "lastModifiedAt")).toBeUndefined();
    expect(fileField(payload({}), "lastModifiedAt")).toBeUndefined();
  });
});

describe("chunkField — missing is not zero", () => {
  it("reads the nested git.chunk number", () => {
    expect(chunkField(payload({ chunk: { lastModifiedAt: 7 } }), "lastModifiedAt")).toBe(7);
  });

  it("returns 0 for a stored zero and undefined for a missing or non-numeric field", () => {
    expect(chunkField(payload({ chunk: { lastModifiedAt: 0 } }), "lastModifiedAt")).toBe(0);
    expect(chunkField(payload({ chunk: {} }), "lastModifiedAt")).toBeUndefined();
    expect(chunkField(payload({ chunk: { lastModifiedAt: "no" } }), "lastModifiedAt")).toBeUndefined();
    expect(chunkField(payload({ file: { lastModifiedAt: 7 } }), "lastModifiedAt")).toBeUndefined();
  });
});

describe("payloadAlpha", () => {
  const both = { file: { commitCount: 20 }, chunk: { commitCount: 10 } };

  it("is 0 at the file level", () => {
    expect(payloadAlpha(payload(both), "file")).toBe(0);
  });

  it("is 0 when the chunk has no commits to speak for itself", () => {
    expect(payloadAlpha(payload({ file: { commitCount: 20 }, chunk: { commitCount: 0 } }))).toBe(0);
    expect(payloadAlpha(payload({ file: { commitCount: 20 } }))).toBe(0);
  });

  it("trusts a chunk-only payload fully", () => {
    expect(payloadAlpha(payload({ chunk: { commitCount: 10 } }))).toBe(1);
  });

  it("blends both levels through computeAlpha — coverage × maturity", () => {
    // chunk 10 of file 20: coverage 0.5, maturity min(1, 10/3) = 1 → alpha 0.5.
    expect(payloadAlpha(payload(both))).toBeCloseTo(0.5, 12);
  });

  it("treats a non-numeric file commitCount as no file data for the blend", () => {
    expect(payloadAlpha(payload({ file: { commitCount: "no" }, chunk: { commitCount: 10 } }))).toBe(0);
  });
});
