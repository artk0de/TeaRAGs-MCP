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
  // of that frame, not with its square.
  //
  // The comparison is against the accumulate-and-rescan loop this replaced,
  // measured on the SAME payload in the SAME process. The gap is ~24x at 16MB,
  // so a 5x floor leaves ample headroom.
  //
  // Each arm is timed REPS times and read at its MINIMUM (bd tea-rags-mcp-lzks3).
  // "Contention slows both arms alike" — the assumption behind the single-sample
  // form this replaces — does not hold, because the arms are not the same size:
  // the decoder arm runs on the order of one scheduling quantum, so a SINGLE
  // preemption landing inside it inflates that arm several-fold, while the ~24x
  // longer legacy arm absorbs the same preemption proportionally. The ratio then
  // collapses toward 1 with neither algorithm having changed; it read 4.97
  // against the 5x floor in a full parallel run. Noise can only ever ADD time to
  // a measurement, never remove it, so the fastest of N observations is the one
  // least perturbed — and the residual error is one-sided, able to depress the
  // ratio (a false red, retried away by more reps) but never to inflate it into
  // a false green.
  it("decodes a large frame far faster than re-splitting the whole accumulator", () => {
    const row = "x".repeat(1024);
    const rows = Array.from({ length: (16 * 1024 * 1024) / (row.length + 3) }, () => row);
    const wire = Buffer.from(encodeFrame({ id: 1, ok: true, result: rows }));

    /** The replaced loop, verbatim: client.ts:145-148 before this change. */
    const legacyDecode = (): string[] => {
      const out: string[] = [];
      let buf = "";
      for (let i = 0; i < wire.length; i += SOCKET_CHUNK) {
        buf += wire.subarray(i, i + SOCKET_CHUNK).toString("utf8");
        const parts = buf.split("\n");
        buf = parts.pop() ?? "";
        out.push(...parts.filter((p) => p.length > 0));
      }
      return out;
    };

    const REPS = 7;
    const fastest = (run: () => string[]): { ms: number; frames: string[] } => {
      let ms = Number.POSITIVE_INFINITY;
      let frames: string[] = [];
      for (let rep = 0; rep < REPS; rep++) {
        const started = process.hrtime.bigint();
        frames = run();
        ms = Math.min(ms, Number(process.hrtime.bigint() - started) / 1e6);
      }
      return { ms, frames };
    };

    const legacy = fastest(legacyDecode);
    const decoder = fastest(() => deliver(new DaemonFrameDecoder(), wire));

    // Same output — the speedup is not bought by decoding less.
    expect(decoder.frames).toEqual(legacy.frames);
    expect(decoder.frames).toHaveLength(1);
    expect(
      legacy.ms / Math.max(decoder.ms, 0.1),
      `legacy ${legacy.ms.toFixed(2)}ms vs decoder ${decoder.ms.toFixed(2)}ms (best of ${REPS})`,
    ).toBeGreaterThan(5);
  });
});
