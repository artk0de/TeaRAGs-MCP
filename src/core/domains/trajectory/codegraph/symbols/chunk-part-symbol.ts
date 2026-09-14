/**
 * Chunker hard-cap part suffix: an oversized symbol is split into chunks whose
 * payload symbolId is `${originalSymbolId}#part${i + 1}` (`Class#method#part1`,
 * `fn#part2`, `Class#part1`). The part belongs to the original symbol.
 *
 * Digits and the end anchor are both required: real method names begin with
 * "part" (`Channel#participants`, `KafkaTopics#partition_key_for`).
 */
const CHUNK_PART_SUFFIX = /#part\d+$/;

/** Map a chunk payload symbolId to the symbol it belongs to, dropping a `#partN` suffix. */
export function stripChunkPartSuffix(symbolId: string): string {
  return symbolId.replace(CHUNK_PART_SUFFIX, "");
}
