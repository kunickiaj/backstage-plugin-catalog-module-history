import type {
  MetricsService,
  MetricsServiceObservableCallback,
  MetricsServiceObservableGauge,
} from '@backstage/backend-plugin-api/alpha';
import { NotFoundError } from '@backstage/errors';

type Source = 'provider' | 'processing' | 'reconciler' | 'all' | 'unknown';
type Outcome = 'success' | 'error';
export type QueryOperation =
  | 'timeline'
  | 'feed'
  | 'versions'
  | 'as_of'
  | 'detail'
  | 'diff'
  | 'providers'
  | 'entities'
  | 'kinds'
  | 'cycles'
  | 'cycle_detail';
type StorageOperation =
  | 'record_cycle'
  | 'load_current_etags'
  | 'load_all_current_etags'
  | 'plan_retention'
  | 'apply_retention';

export interface HistoryStorageMetrics {
  storage<T>(
    operation: StorageOperation,
    source: () => unknown,
    work: () => Promise<T>,
  ): Promise<T>;
  persist<T>(
    source: () => unknown,
    work: () => Promise<T>,
    options?: { callerOwnedTransaction?: boolean },
  ): Promise<T>;
  query<T>(operation: QueryOperation, work: () => Promise<T>): Promise<T>;
  dispose(): void;
}

// Telemetry must never replace a domain result, including when an SDK or an
// error object's getters throw. Domain work is deliberately outside this catch.
function safely(work: () => void): void {
  try {
    work();
  } catch {
    // Metrics are best effort.
  }
}

function sourceLabel(read: () => unknown): Source {
  let source: Source = 'unknown';
  safely(() => {
    const value = read();
    if (
      value === 'provider' ||
      value === 'processing' ||
      value === 'reconciler' ||
      value === 'all'
    ) {
      source = value;
    }
  });
  return source;
}

async function measure<T>(
  work: () => Promise<T>,
  report: (outcome: Outcome, seconds: number, error?: unknown) => void,
): Promise<T> {
  const start = performance.now();
  let outcome: Outcome = 'error';
  let failure: unknown;
  try {
    const result = await work();
    outcome = 'success';
    return result;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    safely(() => report(outcome, (performance.now() - start) / 1000, failure));
  }
}

const noop: HistoryStorageMetrics = {
  storage: (_operation, _source, work) => work(),
  persist: (_source, work) => work(),
  query: (_operation, work) => work(),
  dispose() {},
};

export function createHistoryStorageMetrics(
  metrics?: MetricsService,
): HistoryStorageMetrics {
  if (!metrics) return noop;
  const removals: Array<() => void> = [];
  let disposed = false;
  const dispose = () => {
    disposed = true;
    for (const remove of removals.splice(0)) safely(remove);
  };
  const register = <A extends Record<string, string>>(
    gauge: MetricsServiceObservableGauge<A>,
    callback: MetricsServiceObservableCallback<A>,
  ) => {
    // Keep the removal even if addCallback registers and then throws.
    removals.push(() => gauge.removeCallback(callback));
    gauge.addCallback(callback);
  };
  try {
    const duration = metrics.createHistogram(
      'catalog.history.storage.operation.duration',
      {
        unit: 's',
        advice: {
          explicitBucketBoundaries: [0.001, 0.01, 0.1, 1, 5, 10, 30, 60, 300],
        },
      },
    );
    const lastSuccess = metrics.createObservableGauge<{ source: Source }>(
      'catalog.history.capture.last_success.timestamp',
      { unit: 's' },
    );
    const queryDuration = metrics.createHistogram(
      'catalog.history.query.operation.duration',
      {
        unit: 's',
        advice: {
          explicitBucketBoundaries: [
            0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10,
          ],
        },
      },
    );
    // Only these fixed labels are retained; collection never touches the DB.
    const successes = new Map<Source, number>();
    register(lastSuccess, result => {
      if (disposed) return;
      for (const [source, timestamp] of successes)
        safely(() => result.observe(timestamp, { source }));
    });
    return {
      storage: (operation, source, work) =>
        measure(work, (outcome, seconds) => {
          const attrs = { operation, source: sourceLabel(source), outcome };
          safely(() => duration.record(seconds, attrs));
        }),
      persist: async (source, work, options) => {
        // Releasing a SAVEPOINT does not acknowledge the caller's outer commit.
        // Only that caller owns its commit outcome, so omit the timestamp.
        if (options?.callerOwnedTransaction) return work();
        const result = await work();
        safely(() => {
          if (disposed) return;
          const sourceValue = sourceLabel(source);
          const label = sourceValue === 'all' ? 'unknown' : sourceValue;
          successes.set(label, Date.now() / 1000);
        });
        return result;
      },
      query: (operation, work) =>
        measure(work, (outcome, seconds, error) => {
          let queryOutcome: string = outcome;
          // Classification stays inside the telemetry-only exception boundary.
          safely(() => {
            if (outcome === 'error' && error && typeof error === 'object') {
              if ('code' in error && error.code === '57014')
                queryOutcome = 'timeout';
              else if (error instanceof NotFoundError)
                queryOutcome = 'not_found';
            }
          });
          const attrs = { operation, outcome: queryOutcome };
          safely(() => queryDuration.record(seconds, attrs));
        }),
      dispose,
    };
  } catch {
    dispose();
    return noop;
  }
}
