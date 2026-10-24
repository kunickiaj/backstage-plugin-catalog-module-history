import { createCaptureMetrics } from '../captureMetrics';
import { metricsJournal } from './metricsJournal';

describe('capture metrics SDK contract', () => {
  it('creates only the four literal synchronous instruments with their units', () => {
    // Arrange
    const { metrics } = metricsJournal();

    // Act
    createCaptureMetrics('provider', metrics);

    // Assert
    expect(metrics.createCounter.mock.calls).toEqual([
      ['catalog.history.capture.operations', { unit: '{operation}' }],
      ['catalog.history.capture.phases', { unit: '{phase}' }],
    ]);
    expect(metrics.createHistogram.mock.calls).toEqual([
      ['catalog.history.capture.operation.duration', { unit: 's' }],
      ['catalog.history.capture.phase.duration', { unit: 's' }],
    ]);
    expect(metrics.createGauge).not.toHaveBeenCalled();
    expect(metrics.createUpDownCounter).not.toHaveBeenCalled();
    expect(metrics.createObservableCounter).not.toHaveBeenCalled();
    expect(metrics.createObservableUpDownCounter).not.toHaveBeenCalled();
    expect(metrics.createObservableGauge).not.toHaveBeenCalled();
  });

  it.each(['success', 'error'] as const)(
    'records one count and finite nonnegative duration on %s, not at start',
    outcome => {
      // Arrange
      const { metrics, measurements } = metricsJournal();
      const capture = createCaptureMetrics('processing', metrics);

      // Act
      const stop = capture.startOperation('processing_entity');
      const beforeStop = [...measurements];
      const result = stop(outcome);
      stop(outcome === 'success' ? 'error' : 'success');

      // Assert - stop is synchronous and first-outcome wins.
      expect(beforeStop).toEqual([]);
      expect(result).toBeUndefined();
      expect(measurements).toEqual([
        {
          name: 'catalog.history.capture.operations',
          value: 1,
          attributes: {
            source: 'processing',
            operation: 'processing_entity',
            outcome,
          },
        },
        {
          name: 'catalog.history.capture.operation.duration',
          value: expect.any(Number),
          attributes: {
            source: 'processing',
            operation: 'processing_entity',
            outcome,
          },
        },
      ]);
      expect(Number.isFinite(measurements[1].value)).toBe(true);
      expect(measurements[1].value).toBeGreaterThanOrEqual(0);
    },
  );

  it.each(['success', 'error'] as const)(
    'keeps repeated overlapping phase timers independent on %s',
    outcome => {
      // Arrange
      const { metrics, measurements } = metricsJournal();
      const capture = createCaptureMetrics('reconciler', metrics);

      // Act
      const first = capture.startPhase('prepare');
      const second = capture.startPhase('prepare');
      second(outcome);
      first(outcome);
      first(outcome);

      // Assert
      expect(measurements).toHaveLength(4);
      expect(measurements.filter(m => m.name.endsWith('.phases'))).toEqual(
        Array(2).fill({
          name: 'catalog.history.capture.phases',
          value: 1,
          attributes: { source: 'reconciler', phase: 'prepare', outcome },
        }),
      );
      for (const measurement of measurements) {
        expect(Number.isFinite(measurement.value)).toBe(true);
        expect(measurement.value).toBeGreaterThanOrEqual(0);
      }
    },
  );

  it.each([
    ['create', []],
    [
      'add',
      [
        'catalog.history.capture.operation.duration',
        'catalog.history.capture.phase.duration',
      ],
    ],
    [
      'record',
      ['catalog.history.capture.operations', 'catalog.history.capture.phases'],
    ],
  ] as const)(
    'isolates SDK %s failures and never retries a stopped timer',
    (failure, expectedNames) => {
      // Arrange
      const { metrics, measurements } = metricsJournal(failure);
      const capture = createCaptureMetrics('provider', metrics);

      // Act
      const operation = capture.startOperation('provider_mutation');
      const phase = capture.startPhase('forward');
      operation('error');
      phase('success');
      const firstStop = [...measurements];
      operation('success');
      phase('error');

      // Assert
      expect(measurements).toEqual(firstStop);
      expect(measurements).toHaveLength(failure === 'create' ? 0 : 2);
      expect(measurements.map(m => m.name)).toEqual(expectedNames);
    },
  );

  it('supports manual callers without a metrics service', () => {
    // Arrange
    const capture = createCaptureMetrics('provider');

    // Act
    const operation = capture.startOperation('provider_mutation');
    const phase = capture.startPhase('record');

    // Assert
    expect(operation('success')).toBeUndefined();
    expect(operation('error')).toBeUndefined();
    expect(phase('error')).toBeUndefined();
  });
});
