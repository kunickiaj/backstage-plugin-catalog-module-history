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
export function metricsJournal(failure?: 'create' | 'add' | 'record') {
  const measurements: Measurement[] = [];
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
    if (failure === stage) throw new Error(`SDK ${stage} failed`);
  };
  metrics.createCounter.mockImplementation((name, _options) => {
    fail('create');
    return {
      add: (value, attributes) => {
        fail('add');
        measurements.push({ name, value, attributes });
      },
    };
  });
  metrics.createHistogram.mockImplementation((name, _options) => {
    fail('create');
    return {
      record: (value, attributes) => {
        fail('record');
        measurements.push({ name, value, attributes });
      },
    };
  });
  return { metrics, measurements };
}

export function outcomes(
  measurements: Measurement[],
  source: string,
  label: { operation: string } | { phase: string },
) {
  const name = 'operation' in label ? 'operations' : 'phases';
  return measurements
    .filter(
      entry =>
        entry.name === `catalog.history.capture.${name}` &&
        entry.attributes?.source === source &&
        Object.entries(label).every(
          ([key, value]) => entry.attributes?.[key] === value,
        ),
    )
    .map(entry => entry.attributes?.outcome);
}
