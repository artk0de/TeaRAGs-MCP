import { StringDecoder } from "node:string_decoder";

/**
 * Streaming decoder for the daemon's newline-delimited frame protocol.
 *
 * Both ends of the daemon socket previously accumulated into a string and
 * re-split the WHOLE accumulator on every `data` event:
 *
 *     buf += chunk.toString("utf8");
 *     const { frames, rest } = decodeFrames(buf);
 *
 * That is quadratic in frame size. The daemon proxies entire result sets as one
 * frame (`listAllSymbols`, `getChunkSignalsBulk`, `replacePageRanks`), and the
 * kernel delivers such a frame in ~64KB pieces, so an S-byte frame arriving in
 * pieces of c bytes was rescanned S/c times — O(S²/c) work. Measured on the
 * taxdome index: 64MB payload took 4.9s to decode versus 61ms for the scan-once
 * form below, and cost per megabyte doubled with every doubling of payload.
 * Batching commits (`upsertFilesBulk`, `getChunkSignalsBulk`) made this worse,
 * not better — fewer round-trips, but each frame far larger.
 *
 * Here every byte is scanned once (`lastIndexOf` over the new chunk only) and
 * copied once per frame it belongs to (`join` when a frame completes).
 *
 * `StringDecoder` — rather than `chunk.toString("utf8")` — holds back the bytes
 * of a multi-byte character that straddles a chunk boundary until its remaining
 * bytes arrive. Decoding each chunk independently replaced those split halves
 * with U+FFFD, silently corrupting any non-ASCII payload (symbol names,
 * comments, paths) and sometimes breaking `JSON.parse` outright: over the byte
 * boundaries of one short non-ASCII frame, 25 of 73 split points corrupted.
 */
export class DaemonFrameDecoder {
  /** Buffers an incomplete multi-byte character across chunk boundaries. */
  private readonly utf8 = new StringDecoder("utf8");
  /** Pieces of the frame currently being assembled; joined once it completes. */
  private pieces: string[] = [];

  /** Feed one socket chunk; returns every frame completed by it (possibly none). */
  push(chunk: Buffer): string[] {
    const text = this.utf8.write(chunk);
    if (text.length === 0) return [];

    const lastDelimiter = text.lastIndexOf("\n");
    if (lastDelimiter === -1) {
      // No frame boundary in this chunk — park it without touching what came
      // before. This is the step that makes the whole decode linear.
      this.pieces.push(text);
      return [];
    }

    const completed = this.pieces.join("") + text.slice(0, lastDelimiter);
    const tail = text.slice(lastDelimiter + 1);
    this.pieces = tail.length > 0 ? [tail] : [];

    const frames: string[] = [];
    for (const frame of completed.split("\n")) {
      if (frame.length > 0) frames.push(frame);
    }
    return frames;
  }
}
