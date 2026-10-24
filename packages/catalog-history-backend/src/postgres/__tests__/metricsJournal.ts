import type {
  MetricAttributes,
  MetricOptions,
  MetricsService,
  MetricsServiceObservableCallback,
} from '@backstage/backend-plugin-api/alpha';

type Point = { name: string; value: number; attributes: MetricAttributes };
type Failure =
  | 'create'
  | 'add'
  | 'record'
  | 'callback'
  | 'second_callback'
  | 'remove'
  | 'observe';

// A local SDK boundary fake: no exporter, global provider, timers, or network.
export function metricsJournal(failure?: Failure) {
  const instruments: Array<{ name: string; unit?: string; kind: string }> = [];
  const points: Point[] = [];
  const callbacks = new Map<unknown, () => Promise<void>>();
  const removed: unknown[] = [];
  const sdkError = new Error('private-sdk-error');
  const fail = (phase: Failure) => {
    if (phase === failure) throw sdkError;
  };
  const create = (
    name: string,
    opts: MetricOptions | undefined,
    kind: string,
  ) => {
    fail('create');
    instruments.push({ name, unit: opts?.unit, kind });
  };
  const write = (
    name: string,
    value: number,
    attributes?: MetricAttributes,
  ) => {
    points.push({ name, value, attributes: { ...attributes } });
  };
  const createCounter: MetricsService['createCounter'] = (name, opts) => {
    create(name, opts, 'counter');
    return {
      add(value, attributes) {
        fail('add');
        write(name, value, attributes);
      },
    };
  };
  const createHistogram: MetricsService['createHistogram'] = (name, opts) => {
    create(name, opts, 'histogram');
    return {
      record(value, attributes) {
        fail('record');
        write(name, value, attributes);
      },
    };
  };
  function createObservableGauge<A extends MetricAttributes>(
    name: string,
    opts?: MetricOptions,
  ) {
    create(name, opts, 'gauge');
    return {
      addCallback(callback: MetricsServiceObservableCallback<A>) {
        callbacks.set(callback, async () => {
          await callback({
            observe(value, attributes) {
              fail('observe');
              write(name, value, attributes);
            },
          });
        });
        // Simulate an SDK which registers the callback and then throws.
        fail('callback');
        if (failure === 'second_callback' && callbacks.size === 2)
          throw sdkError;
      },
      removeCallback(callback: MetricsServiceObservableCallback<A>) {
        removed.push(callback);
        fail('remove');
        callbacks.delete(callback);
      },
    };
  }
  const metrics: MetricsService = {
    createCounter,
    createUpDownCounter: createCounter,
    createHistogram,
    createGauge: createHistogram,
    createObservableGauge,
    createObservableCounter: createObservableGauge,
    createObservableUpDownCounter: createObservableGauge,
  };
  return {
    metrics,
    instruments,
    points,
    callbacks,
    removed,
    async collect() {
      const start = points.length;
      for (const callback of callbacks.values()) await callback();
      return points.slice(start);
    },
    values(name: string) {
      return points.filter(point => point.name === name);
    },
  };
}
