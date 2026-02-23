/**
 * ConsistentHash - Consistent hashing ring for shard distribution
 *
 * Uses virtual nodes to ensure even distribution and minimal redistribution
 * when shard count changes.
 */

import { createHash } from "node:crypto";

export interface ConsistentHashOptions {
  virtualNodesPerShard?: number;
}

export class ConsistentHash {
  private readonly ring: Map<number, number> = new Map();
  private sortedPositions: number[] = [];
  private readonly shardCount: number;
  private readonly virtualNodesPerShard: number;

  constructor(shardCount: number, options?: ConsistentHashOptions) {
    if (shardCount < 1) {
      throw new Error("Shard count must be at least 1");
    }

    this.shardCount = shardCount;
    this.virtualNodesPerShard = options?.virtualNodesPerShard ?? 150;

    this.buildRing();
  }

  /**
   * Build the consistent hash ring with virtual nodes
   */
  private buildRing(): void {
    for (let shard = 0; shard < this.shardCount; shard++) {
      for (let v = 0; v < this.virtualNodesPerShard; v++) {
        const key = `shard-${shard}-vnode-${v}`;
        const position = this.hash(key);
        this.ring.set(position, shard);
      }
    }

    this.sortedPositions = [...this.ring.keys()].sort((a, b) => a - b);
  }

  /**
   * Get shard index for a file path
   */
  getShard(filePath: string): number {
    if (this.shardCount === 1) {
      return 0;
    }

    const hash = this.hash(filePath);
    const idx = this.binarySearchCeil(hash);
    const position = this.sortedPositions[idx];
    const shard = this.ring.get(position);
    if (shard === undefined) {
      throw new Error(`No shard found for position ${position}`);
    }
    return shard;
  }

  /**
   * Get the number of shards
   */
  getShardCount(): number {
    return this.shardCount;
  }

  /**
   * Hash a string to unsigned 32-bit integer
   * Using MD5 for speed (not cryptographic use)
   */
  private hash(key: string): number {
    const hash = createHash("md5").update(key).digest();
    // Read first 4 bytes as unsigned 32-bit integer
    return hash.readUInt32BE(0);
  }

  /**
   * Binary search for first position >= target
   * Returns 0 if target is greater than all positions (wrap around)
   */
  private binarySearchCeil(target: number): number {
    const positions = this.sortedPositions;
    let left = 0;
    let right = positions.length;

    while (left < right) {
      const mid = Math.floor((left + right) / 2);
      if (positions[mid] < target) {
        left = mid + 1;
      } else {
        right = mid;
      }
    }

    // Wrap around if target is greater than all positions
    return left === positions.length ? 0 : left;
  }
}
