/** Marketplace name every harness registers the tea-rags plugins under. */
export const TEA_RAGS_MARKETPLACE = "tea-rags";

/** GitHub `owner/repo` of the tea-rags marketplace. */
export const TEA_RAGS_REPO = "artk0de/TeaRAGs-MCP";

export const TEA_RAGS_GIT_URL = `https://github.com/${TEA_RAGS_REPO}.git`;

/**
 * The git tag a tea-rags release is cut from. Plugins must match the client,
 * so every git marketplace is pinned to the client's tag — never a moving branch.
 */
export function releaseTag(clientVersion: string): string {
  return `v${clientVersion}`;
}
