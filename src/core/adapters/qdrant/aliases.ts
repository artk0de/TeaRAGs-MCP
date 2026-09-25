/**
 * Qdrant alias CRUD operations.
 *
 * Wraps the Qdrant alias API with typed methods and error handling. Every op goes
 * through {@link QdrantConnection.call}, so a transport failure gets the same
 * classification (stale-socket retry, reconnect, typed unavailable error) as any
 * other collaborator; the client is read from the connection at call time
 * because a reconnect replaces it.
 *
 * Every failure surfaces as {@link AliasOperationError} — a connection failure
 * that survives `call()` is kept as its typed cause.
 */

import type { CollectionAliasEntry, PhysicalCollectionName } from "../../contracts/types/collection-identity.js";
import { collectionAliasEntryFromQdrant, resolvePhysicalCollection } from "../../infra/collection-name.js";
import type { QdrantConnection } from "./connection.js";
import { AliasOperationError } from "./errors.js";

export class QdrantAliasManager {
  constructor(private readonly connection: QdrantConnection) {}

  async createAlias(alias: string, collection: string): Promise<void> {
    try {
      await this.connection.call(async () =>
        this.connection.client.updateCollectionAliases({
          actions: [
            {
              create_alias: {
                alias_name: alias,
                collection_name: collection,
              },
            },
          ],
        }),
      );
    } catch (error: unknown) {
      throw new AliasOperationError(
        "createAlias",
        `alias="${alias}" collection="${collection}"`,
        error instanceof Error ? error : undefined,
      );
    }
  }

  async switchAlias(alias: string, fromCollection: string, toCollection: string): Promise<void> {
    try {
      await this.connection.call(async () =>
        this.connection.client.updateCollectionAliases({
          actions: [
            {
              delete_alias: {
                alias_name: alias,
              },
            },
            {
              create_alias: {
                alias_name: alias,
                collection_name: toCollection,
              },
            },
          ],
        }),
      );
    } catch (error: unknown) {
      throw new AliasOperationError(
        "switchAlias",
        `alias="${alias}" from="${fromCollection}" to="${toCollection}"`,
        error instanceof Error ? error : undefined,
      );
    }
  }

  async deleteAlias(alias: string): Promise<void> {
    try {
      await this.connection.call(async () =>
        this.connection.client.updateCollectionAliases({
          actions: [
            {
              delete_alias: {
                alias_name: alias,
              },
            },
          ],
        }),
      );
    } catch (error: unknown) {
      throw new AliasOperationError("deleteAlias", `alias="${alias}"`, error instanceof Error ? error : undefined);
    }
  }

  async isAlias(name: string): Promise<boolean> {
    try {
      const response = await this.connection.call(async () => this.connection.client.getAliases());
      return response.aliases.some((a) => a.alias_name === name);
    } catch (error: unknown) {
      throw new AliasOperationError("isAlias", `name="${name}"`, error instanceof Error ? error : undefined);
    }
  }

  async listAliases(): Promise<CollectionAliasEntry[]> {
    try {
      const response = await this.connection.call(async () => this.connection.client.getAliases());
      return response.aliases.map((a) => collectionAliasEntryFromQdrant(a));
    } catch (error: unknown) {
      throw new AliasOperationError(
        "listAliases",
        "failed to list aliases",
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Resolve a name to the ACTIVE underlying collection: if `name` is an alias,
   * return its target collection; otherwise return `name` unchanged (it is
   * already a concrete collection). Lets consumers that address by literal
   * resource (e.g. the codegraph DuckDB pool, which opens a file named after
   * the collection) reach the data the alias points at, since they cannot rely
   * on Qdrant's server-side alias transparency. The rule itself is
   * `resolvePhysicalCollection` — one resolver for every layer (bd tea-rags-mcp-39xca.1).
   */
  async resolveActive(name: string): Promise<PhysicalCollectionName> {
    return resolvePhysicalCollection(name, await this.listAliases());
  }
}
