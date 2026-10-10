/**
 * The call-text marker for Ruby's symbol-to-proc block pass.
 *
 * `users.each(&:save)` desugars to `{ |u| u.save }`: the walker
 * (`walker/call-collection.ts`) emits the block-passed method as its own
 * receiverless CallRef whose `callText` is this prefix plus the member. The
 * resolver reads it to tell that shape from a self-send — the method runs on
 * each ELEMENT the iterator yields, never on `self` (bd
 * tea-rags-mcp-89k7k.35.31). Both sides import it from this leaf, as they do
 * `SUPER_RECEIVER_SENTINEL` from `super-receiver-sentinel.ts`.
 */
export const BLOCK_PASS_CALL_PREFIX = "&:";

/** Whether `callText` is the walker's symbol-to-proc block-pass edge. */
export function isBlockPassCallText(callText: string): boolean {
  return callText.startsWith(BLOCK_PASS_CALL_PREFIX);
}
