/**
 * Bounded concurrency utility for parallel async operations.
 */

/** Default max concurrent I/O operations */
const DEFAULT_CONCURRENCY = 50;

/**
 * Execute promises with bounded concurrency.
 * @param items Items to process
 * @param fn Async function to apply to each item
 * @param concurrency Max parallel operations
 */
export async function parallelLimit<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number = DEFAULT_CONCURRENCY,
): Promise<R[]> {
  const results: R[] = [];
  let index = 0;

  async function worker(): Promise<void> {
    while (index < items.length) {
      const currentIndex = index++;
      const item = items[currentIndex];
      if (item !== undefined) {
        results[currentIndex] = await fn(item);
      }
    }
  }

  const workers = Array(Math.min(concurrency, items.length))
    .fill(null)
    .map(async () => worker());

  await Promise.all(workers);
  return results;
}
