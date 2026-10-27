/**
 * Runs async work one item at a time, in the order it was added. A failed
 * item rejects only its own promise; the next item still runs.
 */
export class OrderedQueue {
  private tail: Promise<void> = Promise.resolve();
  private waiting = 0;

  /** Items added and not yet finished, including the one running. */
  get size(): number {
    return this.waiting;
  }

  run<T>(work: () => Promise<T>): Promise<T> {
    this.waiting++;
    const result = this.tail.then(work).finally(() => {
      this.waiting--;
    });
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
