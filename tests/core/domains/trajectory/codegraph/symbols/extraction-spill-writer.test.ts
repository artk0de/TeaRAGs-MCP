/**
 * CodegraphExtractionSpillWriter (bd tea-rags-mcp-89k7k.35.16) — one NDJSON
 * spill stream of the codegraph run: lazy open behind a `.live` claim, ordered
 * appends honoring back-pressure, append-after-close, close, best-effort
 * cleanup of the spill and its claim. Every I/O failure surfaces as a
 * `CodegraphSpillIoError` naming the spill and the operation.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { spillLiveMarkerPath } from "../../../../../../src/core/contracts/types/codegraph-spill.js";
import { CodegraphExtractionSpillWriter } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/extraction-spill-writer.js";
import { CodegraphSpillIoError } from "../../../../../../src/core/domains/trajectory/errors.js";

interface Row {
  id: number;
  text: string;
}

const ndjson = (rows: readonly Row[]): string => rows.map((row) => `${JSON.stringify(row)}\n`).join("");

describe("CodegraphExtractionSpillWriter", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "spill-writer-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("opens lazily: nothing is on disk and close() is a no-op until the first append", async () => {
    const spillPath = join(tmp, "deep", "run.ndjson");
    const writer = new CodegraphExtractionSpillWriter<Row>(spillPath);

    expect(writer.spillPath).toBe(spillPath);
    expect(writer.rowCount).toBe(0);
    await writer.close();
    expect(existsSync(join(tmp, "deep"))).toBe(false);
  });

  it("claims the spill with a pid marker, then appends one JSON line per row in order", async () => {
    const spillPath = join(tmp, "deep", "run.ndjson");
    const writer = new CodegraphExtractionSpillWriter<Row>(spillPath);
    const rows: Row[] = [
      { id: 1, text: "a" },
      { id: 2, text: "line\nbreak" },
      { id: 3, text: "c" },
    ];

    for (const row of rows) await writer.append(row);
    expect(readFileSync(spillLiveMarkerPath(spillPath), "utf8")).toBe(`${process.pid}`);
    await writer.close();

    expect(readFileSync(spillPath, "utf8")).toBe(ndjson(rows));
    expect(writer.rowCount).toBe(3);
  });

  it("waits out back-pressure so a row larger than the stream buffer still lands whole", async () => {
    const spillPath = join(tmp, "run.ndjson");
    const writer = new CodegraphExtractionSpillWriter<Row>(spillPath);
    const big: Row = { id: 1, text: "x".repeat(256 * 1024) };
    const small: Row = { id: 2, text: "y" };

    await writer.append(big);
    await writer.append(small);
    await writer.close();

    expect(readFileSync(spillPath, "utf8")).toBe(ndjson([big, small]));
  });

  it("appends rows to the closed spill and counts them", async () => {
    const spillPath = join(tmp, "run.ndjson");
    const writer = new CodegraphExtractionSpillWriter<Row>(spillPath);
    const first: Row = { id: 1, text: "walked" };
    const late: Row[] = [
      { id: 2, text: "dependent" },
      { id: 3, text: "dependent" },
    ];

    await writer.append(first);
    await writer.close();
    await writer.appendAfterClose(late);

    expect(readFileSync(spillPath, "utf8")).toBe(ndjson([first, ...late]));
    expect(writer.rowCount).toBe(3);
  });

  it("removes the spill and its claim, idempotently", async () => {
    const spillPath = join(tmp, "run.ndjson");
    const writer = new CodegraphExtractionSpillWriter<Row>(spillPath);
    await writer.append({ id: 1, text: "a" });
    await writer.close();

    await writer.cleanup();
    expect(existsSync(spillPath)).toBe(false);
    expect(existsSync(spillLiveMarkerPath(spillPath))).toBe(false);
    await expect(writer.cleanup()).resolves.toBeUndefined();
  });

  it("raises CodegraphSpillIoError(open) when the spill directory cannot be created", async () => {
    const blocker = join(tmp, "file");
    writeFileSync(blocker, "not a dir");
    const writer = new CodegraphExtractionSpillWriter<Row>(join(blocker, "run.ndjson"));

    const err = await writer.append({ id: 1, text: "a" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CodegraphSpillIoError);
    expect((err as CodegraphSpillIoError).message).toContain("open");
    expect(writer.rowCount).toBe(0);
  });

  it("raises CodegraphSpillIoError(write) when appending after close fails", async () => {
    const writer = new CodegraphExtractionSpillWriter<Row>(join(tmp, "missing-dir", "run.ndjson"));

    const err = await writer.appendAfterClose([{ id: 1, text: "a" }]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CodegraphSpillIoError);
    expect((err as CodegraphSpillIoError).message).toContain("write");
    expect(writer.rowCount).toBe(0);
  });
});
