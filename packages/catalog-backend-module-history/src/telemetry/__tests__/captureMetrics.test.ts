import { performance } from 'node:perf_hooks';
import { createCaptureMetrics } from '../captureMetrics';
import { metricsJournal } from './metricsJournal';

describe('capture metrics SDK contract', () => {
  afterEach(() => jest.restoreAllMocks());

  it('creates exactly one histogram with seconds advice and no other instruments', () => {
    // Arrange
    const { metrics } = metricsJournal();

    // Act
    const capture = createCaptureMetrics('provider', metrics);

    // Assert - counts and errors come from histogram sample counts.
    expect(metrics.createHistogram.mock.calls).toEqual([
      [
        'catalog.history.capture.operation.duration',
        {
          unit: 's',
          advice: {
            explicitBucketBoundaries: [
              0.0001, 0.001, 0.01, 0.1, 1, 5, 10, 30, 60, 300, 600,
            ],
          },
        },
      ],
    ]);
    expect(metrics.createCounter).not.toHaveBeenCalled();
    expect(metrics.createGauge).not.toHaveBeenCalled();
    expect(metrics.createUpDownCounter).not.toHaveBeenCalled();
    expect(metrics.createObservableCounter).not.toHaveBeenCalled();
    expect(metrics.createObservableUpDownCounter).not.toHaveBeenCalled();
    expect(metrics.createObservableGauge).not.toHaveBeenCalled();
    expect(Object.keys(capture)).toEqual(['startOperation']);
  });

  it.each([
    ['provider', 'provider_mutation'],
    ['processing', 'processing_entity'],
    ['processing', 'processing_flush'],
    ['reconciler', 'reconcile'],
  ] as const)(
    'records one %s/%s sample per outcome only at stop',
    (source, operation) => {
      // Arrange
      const { metrics, measurements } = metricsJournal();
      const capture = createCaptureMetrics(source, metrics);
      jest
        .spyOn(performance, 'now')
        .mockReturnValueOnce(1000)
        .mockReturnValueOnce(3500)
        .mockReturnValueOnce(4000)
        .mockReturnValueOnce(4000);

      // Act
      const success = capture.startOperation(operation);
      const beforeStop = [...measurements];
      const result = success('success');
      success('error');
      const error = capture.startOperation(operation);
      error('error');
      error('success');

      // Assert - seconds, zero durations, and first-outcome wins.
      expect(beforeStop).toEqual([]);
      expect(result).toBeUndefined();
      expect(measurements).toEqual([
        {
          name: 'catalog.history.capture.operation.duration',
          value: 2.5,
          attributes: { source, operation, outcome: 'success' },
        },
        {
          name: 'catalog.history.capture.operation.duration',
          value: 0,
          attributes: { source, operation, outcome: 'error' },
        },
      ]);
      for (const measurement of measurements) {
        expect(Number.isFinite(measurement.value)).toBe(true);
        expect(measurement.value).toBeGreaterThanOrEqual(0);
      }
    },
  );

  it('keeps overlapping operation timers independent', () => {
    // Arrange
    const { metrics, measurements } = metricsJournal();
    const capture = createCaptureMetrics('processing', metrics);
    jest
      .spyOn(performance, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(2000)
      .mockReturnValueOnce(5000);

    // Act
    const first = capture.startOperation('processing_entity');
    const second = capture.startOperation('processing_entity');
    second('error');
    first('success');
    first('error');

    // Assert
    expect(measurements.map(m => [m.value, m.attributes?.outcome])).toEqual([
      [1, 'error'],
      [5, 'success'],
    ]);
  });

  it.each(['create', 'record', 'createGetter', 'recordGetter'] as const)(
    'isolates SDK %s failures and never retries a stopped timer',
    failure => {
      // Arrange
      const { metrics, measurements, attempts } = metricsJournal(failure);
      const capture = createCaptureMetrics('provider', metrics);

      // Act
      const stop = capture.startOperation('provider_mutation');
      const result = stop('error');
      stop('success');

      // Assert
      expect(result).toBeUndefined();
      expect(measurements).toEqual([]);
      expect(attempts).toEqual([failure]);
    },
  );

  it('returns a reusable synchronous no-op stop without a metrics service', () => {
    // Arrange
    const capture = createCaptureMetrics('provider');

    // Act
    const operation = capture.startOperation('provider_mutation');
    const success = operation('success');
    const error = operation('error');

    // Assert
    expect(success).toBeUndefined();
    expect(error).toBeUndefined();
    expect(capture.startOperation('provider_mutation')).toBe(operation);
  });
});
