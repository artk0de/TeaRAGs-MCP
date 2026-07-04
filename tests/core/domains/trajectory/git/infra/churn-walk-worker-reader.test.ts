/**
 * w2dlu T6 — the churn-walk worker builds its blob reader IN-THREAD through
 * VcsAdapterFactory (worker-DI per `.claude/rules/domains-language.md`: the
 * job carries only the structured-clone-safe adapter KIND; the worker owns
 * its adapter + reader instances, one per repoRoot, reused across walks).
 *
 * Constructing a "git"-kind reader spawns NOTHING (createBlobBatchReader is
 * lazy — no git process until the first read), so fake roots are safe here.
 */
import { describe, expect, it } from "vitest";

import { resolveWalkBlobReader } from "../../../../../../src/core/domains/trajectory/git/infra/churn-walk/worker.js";

describe("resolveWalkBlobReader (churn-walk worker, w2dlu T6)", () => {
  it("builds a BlobBatchReader via the vcs adapter factory for the job's kind", async () => {
    const reader = await resolveWalkBlobReader("git", "/tmp/fake-walk-root");
    expect(typeof reader.read).toBe("function");
    expect(typeof reader.close).toBe("function");
  });

  it("caches ONE reader per repoRoot across walks (same instance reused)", async () => {
    const a = await resolveWalkBlobReader("git", "/tmp/fake-walk-root-a");
    const b = await resolveWalkBlobReader("git", "/tmp/fake-walk-root-a");
    const c = await resolveWalkBlobReader("git", "/tmp/fake-walk-root-b");
    expect(b).toBe(a);
    expect(c).not.toBe(a);
  });
});
