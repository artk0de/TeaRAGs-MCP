/**
 * Pure split of one embedding batch across endpoints, then across each
 * endpoint's parallel slots.
 *
 * Endpoints are weighted by measured throughput (chars/s); an unmeasured
 * endpoint gets the mean of the measured ones, or 1 when none is measured.
 * Texts are assigned contiguously by cumulative CHARACTER share so every
 * endpoint's sub-batch finishes at about the same time. Each endpoint's run is
 * then cut into `min(slots, run.length)` contiguous sub-requests of near-equal
 * char size. The caller reassembles results by the returned original indices.
 */

export interface EmbeddingFanoutEndpoint {
  url: string;
  /** EWMA throughput; undefined when not measured yet. */
  charsPerSecond?: number;
  /** Parallel request slots the endpoint serves (llama-server `total_slots`). */
  slots: number;
}

export interface EmbeddingFanoutRequest {
  url: string;
  /** Indices into the input texts, ascending. */
  indices: number[];
}

export function splitEmbeddingBatchAcrossEndpoints(
  texts: readonly string[],
  endpoints: readonly EmbeddingFanoutEndpoint[],
): EmbeddingFanoutRequest[] {
  if (texts.length === 0) return [];
  if (endpoints.length === 0) {
    throw new Error(`Cannot split ${texts.length} embedding texts: no endpoint is available`);
  }

  const weights = resolveFanoutWeights(endpoints);
  const serving = endpoints.filter((_, i) => weights[i] > 0);
  const servingWeights = weights.filter((w) => w > 0);
  const chars = texts.map((t) => t.length);
  const indices = texts.map((_, i) => i);

  const requests: EmbeddingFanoutRequest[] = [];
  const runs = partitionContiguousByChars(indices, chars, servingWeights);
  runs.forEach((run, e) => {
    if (run.length === 0) return;
    const slotCount = Math.min(Math.max(1, Math.floor(serving[e].slots)), run.length);
    const runChars = run.map((i) => chars[i]);
    for (const slotRun of partitionContiguousByChars(run, runChars, new Array<number>(slotCount).fill(1))) {
      if (slotRun.length > 0) requests.push({ url: serving[e].url, indices: slotRun });
    }
  });
  return requests;
}

/**
 * Throughput weight per endpoint. Unmeasured endpoints take the mean of the
 * measured ones (1 when none is measured). When every weight is zero the
 * endpoints are weighted equally, so a batch is never left unassigned.
 */
function resolveFanoutWeights(endpoints: readonly EmbeddingFanoutEndpoint[]): number[] {
  const measured = endpoints
    .map((e) => e.charsPerSecond)
    .filter((rate): rate is number => rate !== undefined && Number.isFinite(rate));
  const fallbackWeight = measured.length > 0 ? measured.reduce((sum, r) => sum + r, 0) / measured.length : 1;
  const weights = endpoints.map((e) =>
    e.charsPerSecond !== undefined && Number.isFinite(e.charsPerSecond)
      ? Math.max(0, e.charsPerSecond)
      : fallbackWeight,
  );
  return weights.some((w) => w > 0) ? weights : weights.map(() => 1);
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
