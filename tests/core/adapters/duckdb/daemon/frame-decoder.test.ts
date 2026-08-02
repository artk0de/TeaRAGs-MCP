import { describe, expect, it } from "vitest";

import { DaemonFrameDecoder } from "../../../../../src/core/adapters/duckdb/daemon/frame-decoder.js";
import { encodeFrame, type DaemonResponse } from "../../../../../src/core/adapters/duckdb/daemon/protocol.js";

/** What a unix socket actually hands to a Node `data` listener. */
const SOCKET_CHUNK = 64 * 1024;

/** Split a wire payload the way the kernel delivers it: fixed-size byte chunks. */
function deliver(decoder: DaemonFrameDecoder, wire: Buffer, chunkSize = SOCKET_CHUNK): string[] {
  const frames: string[] = [];
  for (let i = 0; i < wire.length; i += chunkSize) {
    frames.push(...decoder.push(wire.subarray(i, i + chunkSize)));
  }
  return frames;
}

describe("DaemonFrameDecoder", () => {
  it("emits a frame only once its delimiter arrives", () => {
    const decoder = new DaemonFrameDecoder();
    expect(decoder.push(Buffer.from('{"id":1,'))).toEqual([]);
    expect(decoder.push(Buffer.from('"ok":true}'))).toEqual([]);
    expect(decoder.push(Buffer.from("\n"))).toEqual(['{"id":1,"ok":true}']);
  });

  it("emits every frame delivered inside a single chunk", () => {
    const decoder = new DaemonFrameDecoder();
    const wire = Buffer.from(
      encodeFrame({ id: 1, ok: true, result: null }) + encodeFrame({ id: 2, ok: true, result: null }),
    );
    const frames = decoder.push(wire);
    expect(frames).toHaveLength(2);
    expect(frames.map((f) => (JSON.parse(f) as DaemonResponse).id)).toEqual([1, 2]);
  });

  it("carries a partial trailing frame over to the next chunk", () => {
    const decoder = new DaemonFrameDecoder();
    const a = encodeFrame({ id: 1, ok: true, result: null });
    const b = encodeFrame({ id: 2, ok: true, result: null });
    const wire = a + b;
    const cut = a.length + 4; // mid-way through the second frame

    expect(decoder.push(Buffer.from(wire.slice(0, cut)))).toHaveLength(1);
    expect(decoder.push(Buffer.from(wire.slice(cut)))).toEqual([b.slice(0, -1)]);
  });

  // A multi-byte character straddling a chunk boundary is the failure mode of
  // decoding each chunk with `chunk.toString("utf8")` in isolation: the split
  // halves each decode to U+FFFD and the payload is silently corrupted. Symbol
  // names, comments and paths in an indexed repo are routinely non-ASCII, so
  // this is a correctness invariant, not a curiosity.
  it("keeps a multi-byte character intact when it is split across chunks", () => {
    const decoder = new DaemonFrameDecoder();
    const payload = "Пользователь→Документ・日本語・🚀";
    const wire = Buffer.from(encodeFrame({ id: 1, ok: true, result: payload }));

    // Cut inside the first Cyrillic character (2 bytes: leading byte at index 0 of the string body).
    const cut = wire.indexOf(Buffer.from("П")) + 1;
    const frames = [...decoder.push(wire.subarray(0, cut)), ...decoder.push(wire.subarray(cut))];

    expect(frames).toHaveLength(1);
    expect((JSON.parse(frames[0]) as DaemonResponse & { result: string }).result).toBe(payload);
  });

  it("decodes every byte-boundary split of a multi-byte payload identically", () => {
    const payload = "日本語→🚀";
    const wire = Buffer.from(encodeFrame({ id: 1, ok: true, result: payload }));

    for (let cut = 1; cut < wire.length; cut++) {
      const decoder = new DaemonFrameDecoder();
      const frames = [...decoder.push(wire.subarray(0, cut)), ...decoder.push(wire.subarray(cut))];
      expect(frames, `split at byte ${cut}`).toHaveLength(1);
      expect((JSON.parse(frames[0]) as DaemonResponse & { result: string }).result, `split at byte ${cut}`).toBe(
        payload,
      );
    }
  });

  // Complexity guard. The daemon proxies whole result sets (listAllSymbols,
  // getChunkSignalsBulk) as ONE frame, so decode cost must grow with the size
  // of that frame, not with its square. Asserting the RATIO rather than a wall
  // time keeps the bound machine-independent: quadratic decoding costs ~16x for
  // 4x the payload, linear ~4x.
  it("decodes a large frame in time linear in its size", () => {
    const timeFor = (megabytes: number): number => {
      const row = "x".repeat(1024);
      const rows = Array.from({ length: (megabytes * 1024 * 1024) / (row.length + 3) }, () => row);
      const wire = Buffer.from(encodeFrame({ id: 1, ok: true, result: rows }));
      const decoder = new DaemonFrameDecoder();
      const started = process.hrtime.bigint();
      const frames = deliver(decoder, wire);
      const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
      expect(frames).toHaveLength(1);
      return elapsed;
    };

    timeFor(1); // warm up the JIT so the first measurement is not the outlier
    const small = timeFor(4);
    const large = timeFor(16);

    // 4x the payload. Linear stays near 4x; the accumulate-and-rescan decoder
    // this replaces measured ~15x on the same machine.
    expect(large / Math.max(small, 0.5)).toBeLessThan(8);
  });
});
