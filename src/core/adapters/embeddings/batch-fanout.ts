/**
 * Pure planning of one embedding batch into MICRO-BATCHES for work stealing.
 *
 * The batch is cut into contiguous runs of near-equal CHARACTER size, about
 * `EMBEDDING_MICRO_BATCHES_PER_SLOT` per parallel slot across the serving
 * endpoints. Every slot then pulls the next micro-batch from one shared queue,
 * so a fast endpoint naturally takes more of them and the batch's tail is one
 * micro-batch on the slowest endpoint — not that endpoint's whole pre-computed
 * share, which a throughput estimate never gets exactly right. The caller
 * reassembles results by the returned original indices.
 */

/** Micro-batches planned per parallel slot: enough granularity to steal, few enough to keep requests large. */
export const EMBEDDING_MICRO_BATCHES_PER_SLOT = 4;

/**
 * Cut `texts` into contiguous micro-batches of near-equal char size, returned
 * as ascending original indices in input order. Count is
 * `EMBEDDING_MICRO_BATCHES_PER_SLOT × max(1, floor(totalSlots))`, capped at the
 * number of texts, so no micro-batch is empty.
 */
export function planEmbeddingMicroBatches(texts: readonly string[], totalSlots: number): number[][] {
  if (texts.length === 0) return [];
  const slots = Math.max(1, Math.floor(Number.isFinite(totalSlots) ? totalSlots : 1));
  const count = Math.min(texts.length, EMBEDDING_MICRO_BATCHES_PER_SLOT * slots);
  return partitionContiguousByChars(
    texts.map((_, i) => i),
    texts.map((t) => t.length),
    new Array<number>(count).fill(1),
  );
}

/**
 * Cut `items` into `weights.length` contiguous runs whose char totals track the
 * weight shares. Each run ends at the item boundary nearest its cumulative
 * target, takes at least one item while items remain, and leaves at least one
 * item for every later run that can still get one. Runs past the item count
 * come back empty.
 */
function partitionContiguousByChars(
  items: readonly number[],
  chars: readonly number[],
  weights: readonly number[],
): number[][] {
  const n = items.length;
  const parts = weights.length;
  const totalChars = chars.reduce((sum, c) => sum + c, 0);
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);

  const runs: number[][] = [];
  let start = 0;
  let cumulativeChars = 0;
  let cumulativeWeight = 0;
  for (let p = 0; p < parts; p++) {
    if (start >= n) {
      runs.push([]);
      continue;
    }
    cumulativeWeight += weights[p];
    let end: number;
    if (p === parts - 1) {
      end = n;
    } else {
      const target = (totalChars * cumulativeWeight) / totalWeight;
      const maxEnd = n - (parts - p - 1);
      end = start + 1;
      cumulativeChars += chars[start];
      while (end < maxEnd && Math.abs(cumulativeChars + chars[end] - target) < Math.abs(cumulativeChars - target)) {
        cumulativeChars += chars[end];
        end++;
      }
    }
    runs.push(items.slice(start, end));
    start = end;
  }
  return runs;
}
