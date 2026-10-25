import type {
  MetricsService,
  MetricsServiceObservableCallback,
  MetricsServiceObservableGauge,
} from '@backstage/backend-plugin-api/alpha';
import { NotFoundError } from '@backstage/errors';
import type { CycleInput } from '@kunickiaj/backstage-plugin-catalog-history-node';

type Source = 'provider' | 'processing' | 'reconciler' | 'all' | 'unknown';
type Component = 'store' | 'query';
type Outcome = 'success' | 'error';
export type QueryOperation =
  | 'timeline'
  | 'feed'
  | 'versions'
  | 'detail'
  | 'providers'
  | 'entities'
  | 'kinds'
  | 'cycles'
  | 'cycle_detail';
type StorageOperation =
  | 'record_cycle'
  | 'load_current_etags'
  | 'load_all_current_etags';

export interface HistoryStorageMetrics {
  storage<T>(
    operation: StorageOperation,
    source: () => unknown,
    work: () => Promise<T>,
  ): Promise<T>;
  record<T>(input: CycleInput, work: () => Promise<T>): Promise<T>;
  persist<T>(
    source: () => unknown,
    work: () => Promise<T>,
    options?: { callerOwnedTransaction?: boolean },
  ): Promise<T>;
  query<T>(operation: QueryOperation, work: () => Promise<T>): Promise<T>;
  schema<T>(component: Component, work: () => Promise<T>): Promise<T>;
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
  record: (_input, work) => work(),
  persist: (_source, work) => work(),
  query: (_operation, work) => work(),
  schema: (_component, work) => work(),
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
    const operations = metrics.createCounter(
      'catalog.history.storage.operations',
      { unit: '{operation}' },
    );
    const duration = metrics.createHistogram(
      'catalog.history.storage.operation.duration',
      { unit: 's' },
    );
    const persistence = metrics.createHistogram(
      'catalog.history.storage.persistence.duration',
      { unit: 's' },
    );
    const window = metrics.createHistogram(
      'catalog.history.capture.window.duration',
      { unit: 's' },
    );
    const lastSuccess = metrics.createObservableGauge<{ source: Source }>(
      'catalog.history.capture.last_success.timestamp',
      { unit: 's' },
    );
    const queries = metrics.createCounter('catalog.history.query.operations', {
      unit: '{operation}',
    });
    const queryDuration = metrics.createHistogram(
      'catalog.history.query.operation.duration',
      { unit: 's' },
    );
    const initializations = metrics.createCounter(
      'catalog.history.schema.initializations',
      { unit: '{initialization}' },
    );
    const initializationDuration = metrics.createHistogram(
      'catalog.history.schema.initialization.duration',
      { unit: 's' },
    );
    const initialized = metrics.createObservableGauge<{ component: Component }>(
      'catalog.history.schema.initialized',
      { unit: '1' },
    );
    // Only these fixed labels are retained; collection never touches the DB.
    const successes = new Map<Source, number>();
    const schemaState = { store: 0, query: 0 };
    register(lastSuccess, result => {
      if (disposed) return;
      for (const [source, timestamp] of successes)
        safely(() => result.observe(timestamp, { source }));
    });
    register(initialized, result => {
      if (disposed) return;
      for (const component of ['store', 'query'] as const)
        safely(() => result.observe(schemaState[component], { component }));
    });
    return {
      storage: (operation, source, work) =>
        measure(work, (outcome, seconds) => {
          const attrs = { operation, source: sourceLabel(source), outcome };
          safely(() => operations.add(1, attrs));
          safely(() => duration.record(seconds, attrs));
        }),
      record: (input, work) =>
        measure(work, outcome => {
          const seconds =
            (input.finishedAt.getTime() - input.startedAt.getTime()) / 1000;
          if (Number.isFinite(seconds) && seconds >= 0) {
            window.record(seconds, {
              source: sourceLabel(() => input.source),
              outcome,
            });
          }
        }),
      persist: (source, work, options) => {
        // Releasing a SAVEPOINT does not acknowledge the caller's outer commit.
        // Only that caller owns its commit outcome, so omit both commit signals.
        if (options?.callerOwnedTransaction) return work();
        return measure(work, (outcome, seconds) => {
          const sourceValue = sourceLabel(source);
          const label = sourceValue === 'all' ? 'unknown' : sourceValue;
          if (outcome === 'success' && !disposed)
            successes.set(label, Date.now() / 1000);
          persistence.record(seconds, { source: label, outcome });
        });
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
          safely(() => queries.add(1, attrs));
          safely(() => queryDuration.record(seconds, attrs));
        }),
      schema: (component, work) =>
        measure(work, (outcome, seconds) => {
          schemaState[component] = outcome === 'success' ? 1 : 0;
          const attrs = { component, outcome };
          safely(() => initializations.add(1, attrs));
          safely(() => initializationDuration.record(seconds, attrs));
        }),
      dispose,
    };
  } catch {
    dispose();
    return noop;
  }
}
