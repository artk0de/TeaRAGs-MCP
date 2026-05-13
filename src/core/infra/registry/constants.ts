/**
 * Project Registry shared constants.
 *
 * Single source of truth for runtime values consumed by multiple layers
 * (CollectionRegistry, ProjectRegistryOps, MCP register_project tool).
 * Types belong in types.ts; this file holds regex / numeric / string
 * primitives that survive a Zod schema rebuild.
 */

/**
 * Valid project-alias regex. Constraints: lowercase letters, digits, dash,
 * underscore; must start with letter or digit; max 64 chars.
 *
 * **Intended single source of truth.** Callers are being migrated to
 * import this constant instead of redeclaring the literal:
 *
 * - CollectionRegistry.setName — migrating in PR1 Task 2
 * - ProjectRegistryOps.register — migrating in PR1 Task 5
 * - mcp/tools/register-project — migrating in PR1 Task 5
 *
 * Three additional inline copies remain (`schema-builder.ts`,
 * `mcp/tools/schemas.ts`, `cli/commands/projects.ts` describe string) —
 * audit follow-up: extend PR1 Task 5 scope or file a separate ticket
 * before the duplicates calcify.
 */
export const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
