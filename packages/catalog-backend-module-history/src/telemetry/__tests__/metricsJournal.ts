import type {
  MetricAttributes,
  MetricsService,
} from '@backstage/backend-plugin-api/alpha';

export type Measurement = {
  name: string;
  value: number;
  attributes?: MetricAttributes;
};

// Test-local SDK journal: no exporter, registry, clock, or network dependency.
export type MetricsFailure =
  | 'create'
  | 'record'
  | 'createGetter'
  | 'recordGetter';

export function metricsJournal(failure?: MetricsFailure) {
  const measurements: Measurement[] = [];
  const attempts: MetricsFailure[] = [];
  const metrics: jest.Mocked<MetricsService> = {
    createCounter: jest.fn(),
    createHistogram: jest.fn(),
    createUpDownCounter: jest.fn(),
    createGauge: jest.fn(),
    createObservableCounter: jest.fn(),
    createObservableUpDownCounter: jest.fn(),
    createObservableGauge: jest.fn(),
  };
  const fail = (stage: typeof failure) => {
    if (failure === stage && stage) {
      attempts.push(stage);
      throw new Error(`SDK ${stage} failed`);
    }
  };
  metrics.createCounter.mockImplementation((name, _options) => {
    return {
      add: (value, attributes) => {
        measurements.push({ name, value, attributes });
      },
    };
  });
  metrics.createHistogram.mockImplementation((name, _options) => {
    fail('create');
    if (failure === 'recordGetter') {
      return Object.defineProperty({}, 'record', {
        get: () => fail('recordGetter'),
      }) as ReturnType<MetricsService['createHistogram']>;
    }
    return {
      record: (value, attributes) => {
        fail('record');
        measurements.push({ name, value, attributes });
      },
    };
  });
  if (failure === 'createGetter') {
    Object.defineProperty(metrics, 'createHistogram', {
      get: () => fail('createGetter'),
    });
  }
  return { metrics, measurements, attempts };
}

export function outcomes(
  measurements: Measurement[],
  source: string,
  label: { operation: string },
) {
  return measurements
    .filter(
      entry =>
        entry.name === 'catalog.history.capture.operation.duration' &&
        entry.attributes?.source === source &&
        Object.entries(label).every(
          ([key, value]) => entry.attributes?.[key] === value,
        ),
    )
    .map(entry => entry.attributes?.outcome);
}
