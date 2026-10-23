import {
  resolveLocalBinding,
  type CallContext,
  type CallResultBinding,
  type LocalBinding,
} from "../../../../contracts/types/codegraph.js";
import { rustCallResultBindingOf } from "./declared-call-result-type.js";

/**
 * The binding a Rust receiver name denotes at a call site, across the two
 * channels the walker writes (bd tea-rags-mcp-s3i8m):
 *
 *   - `local` — a `localBindings` entry (fn parameter, annotated `let`,
 *     pattern binding, the `let x = T::new(..)` constructor heuristic);
 *   - `callResult` — a `callResultBindings` `let x = call()` whose window
 *     holds the line.
 *
 * Rust shadowing: the binding declared LATER answers. A call-result `let`
 * below a parameter (`let mut sink = Some(sink);`) shadows it even when the
 * callee's return is unknown — `shadowsLocal` tells a reader not to fall back
 * to the shadowed type. A local and a call-result binding on ONE line are the
 * same `let`: the walker's constructor heuristic typed it, and the
 * `constructor` arm lets the callee's declared return speak first.
 */
export type RustVisibleReceiverBinding =
  | { readonly channel: "local"; readonly binding: LocalBinding }
  | { readonly channel: "callResult"; readonly binding: CallResultBinding; readonly shadowsLocal: boolean }
  | { readonly channel: "constructor"; readonly binding: LocalBinding; readonly callResult: CallResultBinding };

export function rustVisibleReceiverBinding(
  receiver: string,
  atLine: number,
  ctx: CallContext,
  atColumn?: number,
): RustVisibleReceiverBinding | undefined {
  const localBinding = resolveLocalBinding(ctx.localBindings, receiver, atLine, atColumn);
  const callResult = rustCallResultBindingOf(receiver, atLine, ctx);
  if (callResult === undefined) {
    return localBinding === undefined ? undefined : { channel: "local", binding: localBinding };
  }
  if (localBinding === undefined || callResult.line > localBinding.line) {
    return { channel: "callResult", binding: callResult, shadowsLocal: localBinding !== undefined };
  }
  if (callResult.line === localBinding.line && (localBinding.valueKind ?? "instance") === "instance") {
    return { channel: "constructor", binding: localBinding, callResult };
  }
  return { channel: "local", binding: localBinding };
}
