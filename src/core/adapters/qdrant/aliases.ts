/**
 * Qdrant alias CRUD operations.
 *
 * Wraps QdrantClient alias API with typed methods and error handling.
 */

import type { QdrantClient } from "@qdrant/js-client-rest";

import { AliasOperationError } from "./errors.js";

export class QdrantAliasManager {
  constructor(private readonly client: QdrantClient) {}

  async createAlias(alias: string, collection: string): Promise<void> {
    try {
      await this.client.updateCollectionAliases({
        actions: [
          {
            create_alias: {
              alias_name: alias,
              collection_name: collection,
            },
          },
        ],
      });
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
      await this.client.updateCollectionAliases({
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
      });
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
      await this.client.updateCollectionAliases({
        actions: [
          {
            delete_alias: {
              alias_name: alias,
            },
          },
        ],
      });
    } catch (error: unknown) {
      throw new AliasOperationError("deleteAlias", `alias="${alias}"`, error instanceof Error ? error : undefined);
    }
  }

  async isAlias(name: string): Promise<boolean> {
    try {
      const response = await this.client.getAliases();
      return response.aliases.some((a) => a.alias_name === name);
    } catch (error: unknown) {
      throw new AliasOperationError("isAlias", `name="${name}"`, error instanceof Error ? error : undefined);
    }
  }

  async listAliases(): Promise<{ aliasName: string; collectionName: string }[]> {
    try {
      const response = await this.client.getAliases();
      return response.aliases.map((a) => ({
        aliasName: a.alias_name,
        collectionName: a.collection_name,
      }));
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
   * on Qdrant's server-side alias transparency.
   */
  async resolveActive(name: string): Promise<string> {
    const aliases = await this.listAliases();
    return aliases.find((a) => a.aliasName === name)?.collectionName ?? name;
  }
}
