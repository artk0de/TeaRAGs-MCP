/**
 * Addressing pair a tool call emitted by tea-rags carries (agent turn economy,
 * cross-cutting rule). The agent follows an emitted call verbatim, so it must
 * name the tree that answered — never the registry's checkout when the caller
 * addressed a linked worktree or a diverged tree.
 */
export interface ToolCallAddress {
  project?: string;
  path?: string;
}

/**
 * A ready-to-run next call attached to an answer (N5 `next`). `args` already
 * carry the {@link ToolCallAddress} of the answering tree.
 */
export interface SuggestedToolCall {
  tool: string;
  args: ToolCallAddress & Record<string, unknown>;
  /** One clause: what the call returns and why it helps here. */
  why: string;
}
