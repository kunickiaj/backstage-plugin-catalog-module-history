import type { CycleInput } from '@kunickiaj/backstage-plugin-catalog-history-node';
import { createHistoryStorageMetrics } from '../historyStorageMetrics';
import { metricsJournal } from './metricsJournal';

function input(startedAt: Date, finishedAt: Date): CycleInput {
  return {
    cycleId: 'private-cycle',
    provider: 'private-provider',
    source: 'provider',
    mutationType: 'full',
    startedAt,
    finishedAt,
    inserts: [],
    updates: [],
    deletes: [],
    unchangedCount: 0,
  };
}

afterEach(() => jest.restoreAllMocks());

describe('history storage metrics boundary cases', () => {
  it.each([
    [new Date(1000), new Date(2000), [1]],
    [new Date(1000), new Date(1000), [0]],
    [new Date(2000), new Date(1000), []],
    [new Date(NaN), new Date(1000), []],
    [new Date(1000), new Date(NaN), []],
  ])(
    'records only finite nonnegative capture windows (%s, %s)',
    async (start, finish, values) => {
      // Arrange
      const journal = metricsJournal();
      const metrics = createHistoryStorageMetrics(journal.metrics);
      const capture = input(start, finish);
      const error = new Error('private-domain-error');
      const success = jest.fn().mockResolvedValue('result');
      const failure = jest.fn().mockRejectedValue(error);
      // Act / Assert: neither invalid capture time nor failed work is rewritten.
      await expect(metrics.record(capture, success)).resolves.toBe('result');
      await expect(metrics.record(capture, failure)).rejects.toBe(error);
      expect(success).toHaveBeenCalledTimes(1);
      expect(failure).toHaveBeenCalledTimes(1);
      expect(capture.startedAt).toBe(start);
      expect(capture.finishedAt).toBe(finish);
      expect(journal.values('catalog.history.capture.window.duration')).toEqual(
        ['success', 'error'].flatMap(outcome =>
          values.map(value => ({
            name: 'catalog.history.capture.window.duration',
            value,
            attributes: { source: 'provider', outcome },
          })),
        ),
      );
      metrics.dispose();
    },
  );

  it('aggregates last success by four fixed sources, clamps malformed input, and does not advance on errors', async () => {
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
    // Act
    for (const source of sources) {
      await metrics.persist(
        () => source,
        async () => undefined,
      );
    }
    const before = (await journal.collect()).filter(
      point => point.name === 'catalog.history.capture.last_success.timestamp',
    );
    now.mockReturnValue(1900000000000);
    const error = new Error('private-error-payload');
    for (const source of sources) {
      await expect(
        metrics.persist(
          () => source,
          async () => {
            throw error;
          },
        ),
      ).rejects.toBe(error);
    }
    const after = (await journal.collect()).filter(
      point => point.name === 'catalog.history.capture.last_success.timestamp',
    );
    // Assert: repeated captures share a source point rather than retaining provider identities.
    expect(before).toEqual(
      ['provider', 'processing', 'reconciler', 'unknown'].map(source => ({
        name: 'catalog.history.capture.last_success.timestamp',
        value: 1800000000,
        attributes: { source },
      })),
    );
    expect(after).toEqual(before);
    expect(
      journal
        .values('catalog.history.storage.persistence.duration')
        .map(point => point.attributes),
    ).toEqual(
      ['success', 'error'].flatMap(outcome =>
        [
          'provider',
          'processing',
          'reconciler',
          'unknown',
          'unknown',
          'unknown',
        ].map(source => ({ source, outcome })),
      ),
    );
    metrics.dispose();
  });

  it('preserves successful values and original errors without a metrics service', async () => {
    // Arrange
    const metrics = createHistoryStorageMetrics();
    const result = { private: 'value' };
    const error = new Error('private-error');
    const work = jest.fn().mockResolvedValue(result);
    const fail = jest.fn().mockRejectedValue(error);
    // Act / Assert
    await expect(
      metrics.storage('load_current_etags', () => 'provider', work),
    ).resolves.toBe(result);
    await expect(metrics.query('feed', fail)).rejects.toBe(error);
    expect(work).toHaveBeenCalledTimes(1);
    expect(fail).toHaveBeenCalledTimes(1);
    expect(() => {
      metrics.dispose();
      metrics.dispose();
    }).not.toThrow();
  });
});
