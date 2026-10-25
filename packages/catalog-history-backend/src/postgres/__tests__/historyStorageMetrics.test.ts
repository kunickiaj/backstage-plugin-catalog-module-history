import { NotFoundError } from '@backstage/errors';
import { createHistoryStorageMetrics } from '../historyStorageMetrics';
import { metricsJournal } from './metricsJournal';

const storageDuration = 'catalog.history.storage.operation.duration';
const queryDuration = 'catalog.history.query.operation.duration';
const lastSuccess = 'catalog.history.capture.last_success.timestamp';

afterEach(() => jest.restoreAllMocks());

describe('history storage metrics boundary cases', () => {
  it('creates only duration histograms and a passive last-success gauge with bucket advice in seconds', async () => {
    // Arrange
    const journal = metricsJournal();
    // Act
    const metrics = createHistoryStorageMetrics(journal.metrics);
    const collected = await journal.collect();
    // Assert: the exact set excludes counters, schema, window, and persistence instruments.
    expect(journal.instruments).toEqual([
      {
        name: storageDuration,
        kind: 'histogram',
        unit: 's',
        advice: {
          explicitBucketBoundaries: [0.001, 0.01, 0.1, 1, 5, 10, 30, 60, 300],
        },
      },
      { name: lastSuccess, kind: 'gauge', unit: 's' },
      {
        name: queryDuration,
        kind: 'histogram',
        unit: 's',
        advice: {
          explicitBucketBoundaries: [
            0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10,
          ],
        },
      },
    ]);
    for (const instrument of journal.instruments.filter(
      item => item.kind === 'histogram',
    )) {
      const bounds = instrument.advice!.explicitBucketBoundaries!;
      expect(
        bounds.every(
          (value, index) =>
            Number.isFinite(value) &&
            value > 0 &&
            (index === 0 || value > bounds[index - 1]),
        ),
      ).toBe(true);
    }
    expect(collected).toEqual([]);
    expect(journal.points).toEqual([]);
    metrics.dispose();
  });

  it('records elapsed seconds and fixed attributes on storage success and error', async () => {
    // Arrange
    const journal = metricsJournal();
    const metrics = createHistoryStorageMetrics(journal.metrics);
    let clock = 1000;
    jest.spyOn(performance, 'now').mockImplementation(() => clock);
    const result = { private: 'value' };
    const error = new Error('private-error');
    // Act / Assert: each domain invocation produces one sample, not a counter value.
    await expect(
      metrics.storage(
        'load_current_etags',
        () => 'provider',
        async () => {
          clock += 250;
          return result;
        },
      ),
    ).resolves.toBe(result);
    await expect(
      metrics.storage(
        'load_current_etags',
        () => 'private-source',
        async () => {
          clock += 500;
          throw error;
        },
      ),
    ).rejects.toBe(error);
    expect(journal.values(storageDuration)).toEqual([
      {
        name: storageDuration,
        value: 0.25,
        attributes: {
          operation: 'load_current_etags',
          source: 'provider',
          outcome: 'success',
        },
      },
      {
        name: storageDuration,
        value: 0.5,
        attributes: {
          operation: 'load_current_etags',
          source: 'unknown',
          outcome: 'error',
        },
      },
    ]);
    metrics.dispose();
  });

  it.each([
    'timeline',
    'feed',
    'versions',
    'as_of',
    'detail',
    'providers',
    'entities',
    'kinds',
    'cycles',
    'cycle_detail',
  ] as const)(
    'preserves %s results and classifies failures without leaking error properties',
    async operation => {
      // Arrange
      const journal = metricsJournal();
      const metrics = createHistoryStorageMetrics(journal.metrics);
      const clock = { milliseconds: 0 };
      jest
        .spyOn(performance, 'now')
        .mockImplementation(() => clock.milliseconds);
      const errors = [
        new Error('private-error'),
        { code: '57014', sql: 'private-sql' },
        new NotFoundError('private-detail'),
      ];
      // Act / Assert
      await expect(
        metrics.query(operation, async () => {
          clock.milliseconds += 125;
          return 'result';
        }),
      ).resolves.toBe('result');
      for (const error of errors) {
        await expect(
          metrics.query(operation, async () => {
            clock.milliseconds += 125;
            throw error;
          }),
        ).rejects.toBe(error);
      }
      expect(journal.values(queryDuration)).toEqual(
        ['success', 'error', 'timeout', 'not_found'].map(outcome => ({
          name: queryDuration,
          value: 0.125,
          attributes: { operation, outcome },
        })),
      );
      metrics.dispose();
    },
  );

  it('aggregates successful acknowledgments by fixed sources and never advances on failed work', async () => {
    // Arrange
    const journal = metricsJournal();
    const metrics = createHistoryStorageMetrics(journal.metrics);
    const now = jest.spyOn(Date, 'now').mockReturnValue(1800000000000);
    const sources = [
      'provider',
      'processing',
      'reconciler',
      'private-source',
      undefined,
      'all',
    ];
    const error = new Error('private-error');
    // Act
    for (const source of sources)
      await metrics.persist(
        () => source,
        async () => 'result',
      );
    const before = await journal.collect();
    now.mockReturnValue(1900000000000);
    for (const source of sources)
      await expect(
        metrics.persist(
          () => source,
          async () => {
            throw error;
          },
        ),
      ).rejects.toBe(error);
    const after = await journal.collect();
    // Assert: quiet sources retain their original timestamp, not collection time.
    expect(before).toEqual(
      ['provider', 'processing', 'reconciler', 'unknown'].map(source => ({
        name: lastSuccess,
        value: 1800000000,
        attributes: { source },
      })),
    );
    expect(after).toEqual(before);
    expect(journal.points.filter(point => point.name !== lastSuccess)).toEqual(
      [],
    );
    metrics.dispose();
  });

  it.each([
    'create',
    'gauge_create',
    'record',
    'callback',
    'observe',
    'remove',
    undefined,
  ] as const)(
    'preserves values and original errors when the SDK fails at %s',
    async failure => {
      // Arrange
      const journal = metricsJournal(failure);
      const metrics = createHistoryStorageMetrics(journal.metrics);
      const result = { private: 'value' };
      const error = new Error('private-domain-error');
      const work = jest.fn().mockResolvedValue(result);
      const fail = jest.fn().mockRejectedValue(error);
      // Act / Assert
      await expect(
        metrics.storage('record_cycle', () => 'provider', work),
      ).resolves.toBe(result);
      await expect(metrics.query('feed', fail)).rejects.toBe(error);
      await expect(metrics.persist(() => 'provider', work)).resolves.toBe(
        result,
      );
      await expect(metrics.persist(() => 'provider', fail)).rejects.toBe(error);
      await expect(journal.collect()).resolves.toBeDefined();
      expect(work).toHaveBeenCalledTimes(2);
      expect(fail).toHaveBeenCalledTimes(2);
      expect(() => {
        metrics.dispose();
        metrics.dispose();
      }).not.toThrow();
      expect(await journal.collect()).toEqual([]);
      expect(journal.removed).toHaveLength(
        failure === 'create' || failure === 'gauge_create' ? 0 : 1,
      );
    },
  );

  it.each([
    'createHistogram',
    'createObservableGauge',
    'record',
    'addCallback',
    'removeCallback',
  ] as const)(
    'preserves domain work when the SDK %s property getter throws',
    async property => {
      // Arrange
      const journal = metricsJournal();
      const getter = () => {
        throw new Error('sdk-getter-error');
      };
      if (
        property === 'createHistogram' ||
        property === 'createObservableGauge'
      ) {
        Object.defineProperty(journal.metrics, property, { get: getter });
      } else if (property === 'record') {
        const create = journal.metrics.createHistogram;
        jest
          .spyOn(journal.metrics, 'createHistogram')
          .mockImplementation((...args) => {
            const histogram = create(...args);
            Object.defineProperty(histogram, 'record', { get: getter });
            return histogram;
          });
      } else {
        const create = journal.metrics.createObservableGauge;
        jest
          .spyOn(journal.metrics, 'createObservableGauge')
          .mockImplementation((...args) => {
            const gauge = create(...args);
            Object.defineProperty(gauge, property, { get: getter });
            return gauge;
          });
      }
      const metrics = createHistoryStorageMetrics(journal.metrics);
      const error = new Error('domain-error');
      const work = jest.fn().mockResolvedValue('result');
      const failure = jest.fn().mockRejectedValue(error);
      // Act / Assert: reading SDK methods is part of the telemetry boundary.
      await expect(
        metrics.storage('record_cycle', () => 'provider', work),
      ).resolves.toBe('result');
      await expect(metrics.query('feed', failure)).rejects.toBe(error);
      await expect(metrics.persist(() => 'provider', work)).resolves.toBe(
        'result',
      );
      await expect(metrics.persist(() => 'provider', failure)).rejects.toBe(
        error,
      );
      expect(work).toHaveBeenCalledTimes(2);
      expect(failure).toHaveBeenCalledTimes(2);
      expect(() => {
        metrics.dispose();
        metrics.dispose();
      }).not.toThrow();
      expect(await journal.collect()).toEqual([]);
    },
  );

  it('preserves persistence results and errors when reading the success clock throws', async () => {
    // Arrange
    const journal = metricsJournal();
    const metrics = createHistoryStorageMetrics(journal.metrics);
    jest.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('clock-error');
    });
    const error = new Error('domain-error');
    // Act / Assert: only the optional timestamp is lost.
    await expect(
      metrics.persist(
        () => 'provider',
        async () => 'result',
      ),
    ).resolves.toBe('result');
    await expect(
      metrics.persist(
        () => 'provider',
        async () => {
          throw error;
        },
      ),
    ).rejects.toBe(error);
    expect(await journal.collect()).toEqual([]);
    metrics.dispose();
  });

  it('runs domain work without metrics and preserves its original failure', async () => {
    // Arrange
    const metrics = createHistoryStorageMetrics();
    const result = {};
    const error = new Error('private-error');
    const success = jest.fn().mockResolvedValue(result);
    const failure = jest.fn().mockRejectedValue(error);
    // Act / Assert
    await expect(
      metrics.storage('load_current_etags', () => 'provider', success),
    ).resolves.toBe(result);
    await expect(metrics.query('feed', failure)).rejects.toBe(error);
    await expect(metrics.persist(() => 'provider', success)).resolves.toBe(
      result,
    );
    await expect(metrics.persist(() => 'provider', failure)).rejects.toBe(
      error,
    );
    expect(success).toHaveBeenCalledTimes(2);
    expect(failure).toHaveBeenCalledTimes(2);
    expect(() => {
      metrics.dispose();
      metrics.dispose();
    }).not.toThrow();
  });

  it('does not replace domain results when source or error getters throw', async () => {
    // Arrange
    const journal = metricsJournal();
    const metrics = createHistoryStorageMetrics(journal.metrics);
    const error = Object.defineProperty(new Error('domain-error'), 'code', {
      get() {
        throw new Error('getter-error');
      },
    });
    const source = () => {
      throw new Error('source-error');
    };
    // Act / Assert
    await expect(
      metrics.storage('record_cycle', source, async () => 'result'),
    ).resolves.toBe('result');
    await expect(
      metrics.storage('record_cycle', source, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    await expect(
      metrics.query('feed', async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    await expect(metrics.persist(source, async () => 'result')).resolves.toBe(
      'result',
    );
    expect(
      journal.values(storageDuration).map(point => point.attributes),
    ).toEqual(
      ['success', 'error'].map(outcome => ({
        operation: 'record_cycle',
        source: 'unknown',
        outcome,
      })),
    );
    expect(journal.values(queryDuration)[0].attributes).toEqual({
      operation: 'feed',
      outcome: 'error',
    });
    expect((await journal.collect())[0].attributes).toEqual({
      source: 'unknown',
    });
    metrics.dispose();
  });

  it.each([undefined, 'remove'] as const)(
    'does not publish caller-owned commits or revive a disposed acknowledgment when removal is %s',
    async failure => {
      // Arrange
      const journal = metricsJournal(failure);
      const metrics = createHistoryStorageMetrics(journal.metrics);
      const now = jest.spyOn(Date, 'now').mockReturnValue(1800000000000);
      let acknowledge!: (value: string) => void;
      const pending = new Promise<string>(resolve => {
        acknowledge = resolve;
      });
      // Act
      await expect(
        metrics.persist(
          () => 'provider',
          async () => 'outer-result',
          { callerOwnedTransaction: true },
        ),
      ).resolves.toBe('outer-result');
      const inFlight = metrics.persist(
        () => 'provider',
        () => pending,
      );
      const before = await journal.collect();
      metrics.dispose();
      acknowledge('committed');
      await expect(inFlight).resolves.toBe('committed');
      await expect(
        metrics.persist(
          () => 'processing',
          async () => 'later',
        ),
      ).resolves.toBe('later');
      metrics.dispose();
      // Assert
      expect(before).toEqual([]);
      expect(journal.removed).toHaveLength(1);
      expect(journal.callbacks.size).toBe(failure === 'remove' ? 1 : 0);
      expect(now).not.toHaveBeenCalled();
      expect(await journal.collect()).toEqual([]);
    },
  );
});
