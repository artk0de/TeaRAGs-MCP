import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  downloadVerifiedFile,
  NativeAssetDownloadError,
  NativeAssetIntegrityError,
  type NativeAssetDeps,
} from "../../../../src/core/adapters/native-assets/index.js";

const PAYLOAD = Buffer.from("native asset bytes");
const PAYLOAD_SHA = createHash("sha256").update(PAYLOAD).digest("hex");

describe("downloadVerifiedFile", () => {
  let server: Server;
  let baseUrl: string;
  let requests: string[];
  let dir: string;
  const deps: NativeAssetDeps = { fetch: async (input, init) => fetch(input, init) };

  beforeAll(async () => {
    server = createServer((req, res) => {
      requests.push(req.url ?? "");
      if (req.url === "/asset.bin") {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(PAYLOAD);
        return;
      }
      res.writeHead(404);
      res.end("missing");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  beforeEach(() => {
    requests = [];
    dir = mkdtempSync(join(tmpdir(), "verified-download-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("downloads the file and returns its path", async () => {
    const path = await downloadVerifiedFile(
      { url: `${baseUrl}/asset.bin`, sha256: PAYLOAD_SHA, fileName: "asset.bin" },
      dir,
      deps,
    );

    expect(path).toBe(join(dir, "asset.bin"));
    expect(readFileSync(path)).toEqual(PAYLOAD);
    expect(readdirSync(dir)).toEqual(["asset.bin"]);
  });

  it("throws sha256 mismatch and leaves neither the final file nor the .partial", async () => {
    const wrongSha = createHash("sha256").update("other bytes").digest("hex");

    await expect(
      downloadVerifiedFile({ url: `${baseUrl}/asset.bin`, sha256: wrongSha, fileName: "asset.bin" }, dir, deps),
    ).rejects.toThrow(/sha256 mismatch/);

    expect(existsSync(join(dir, "asset.bin"))).toBe(false);
    expect(existsSync(join(dir, "asset.bin.partial"))).toBe(false);
  });

  it("makes zero requests when the final file is already present with the matching digest", async () => {
    writeFileSync(join(dir, "asset.bin"), PAYLOAD);

    const path = await downloadVerifiedFile(
      { url: `${baseUrl}/asset.bin`, sha256: PAYLOAD_SHA, fileName: "asset.bin" },
      dir,
      deps,
    );

    expect(path).toBe(join(dir, "asset.bin"));
    expect(requests).toEqual([]);
  });

  it("throws naming the URL on HTTP 404", async () => {
    const url = `${baseUrl}/nope.bin`;

    await expect(downloadVerifiedFile({ url, sha256: PAYLOAD_SHA, fileName: "nope.bin" }, dir, deps)).rejects.toThrow(
      url,
    );
    expect(readdirSync(dir)).toEqual([]);
  });

  describe("typed failures (CLI handlers print message + hint for a TeaRagsError)", () => {
    it("an HTTP failure is a NativeAssetDownloadError naming the URL and status", async () => {
      const url = `${baseUrl}/nope.bin`;

      const error = await downloadVerifiedFile({ url, sha256: PAYLOAD_SHA, fileName: "nope.bin" }, dir, deps).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(NativeAssetDownloadError);
      expect(error).toMatchObject({ code: "INFRA_NATIVE_ASSET_DOWNLOAD_FAILED" });
      expect((error as Error).message).toContain(url);
      expect((error as Error).message).toContain("404");
      expect((error as NativeAssetDownloadError).hint).toContain("HTTPS_PROXY");
    });

    it("a rejected fetch is a NativeAssetDownloadError carrying the raw error as cause", async () => {
      const raw = new TypeError("fetch failed");
      const url = `${baseUrl}/asset.bin`;
      const rejecting: NativeAssetDeps = {
        fetch: async () => {
          throw raw;
        },
      };

      const error = await downloadVerifiedFile(
        { url, sha256: PAYLOAD_SHA, fileName: "asset.bin" },
        dir,
        rejecting,
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(NativeAssetDownloadError);
      expect((error as Error).message).toContain(url);
      expect((error as Error).cause).toBe(raw);
      expect(readdirSync(dir)).toEqual([]);
    });

    it("a digest mismatch is a NativeAssetIntegrityError naming both digests, with a re-run hint", async () => {
      const wrongSha = createHash("sha256").update("other bytes").digest("hex");

      const error = await downloadVerifiedFile(
        { url: `${baseUrl}/asset.bin`, sha256: wrongSha, fileName: "asset.bin" },
        dir,
        deps,
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(NativeAssetIntegrityError);
      expect(error).toMatchObject({ code: "INFRA_NATIVE_ASSET_INTEGRITY_MISMATCH" });
      expect((error as Error).message).toContain(wrongSha);
      expect((error as Error).message).toContain(PAYLOAD_SHA);
      expect((error as NativeAssetIntegrityError).hint).toMatch(/re-run/i);
    });
  });
});
