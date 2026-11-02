/**
 * Chunk names for Objective-C.
 *
 * A `method_definition` has no `name` field. The generic extractor would take
 * the first direct identifier, which is only the first keyword (`setName` out
 * of `setName:age:`), or — if a return type were ever promoted to a direct
 * identifier — the callee of nothing, but the wrong symbol. `objcChunkName`
 * returns the full selector. Message sends are not chunkable, so a chunk
 * cannot take a callee's name; a statement classifier is not required.
 *
 * Child extraction still classifies `method_definition` through the shared
 * `classifyMethod`, which treats that node type as an instance method. `-`
 * methods therefore chunk as `Class#selector`, matching `nameOf`. `+` methods
 * chunk as `Class#selector` too, while `nameOf` composes `Class.selector`,
 * until `classifyMethod` learns the `+` sign.
 */

export { objcChunkName } from "../naming.js";
