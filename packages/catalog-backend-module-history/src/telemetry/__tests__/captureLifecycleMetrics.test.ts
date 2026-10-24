import type { Entity } from '@backstage/catalog-model';
import { mockServices } from '@backstage/backend-test-utils';
import type {
  CatalogProcessorCache,
  EntityProviderConnection,
  EntityProviderMutation,
} from '@backstage/plugin-catalog-node';
import { InMemoryHistoryStore } from '@kunickiaj/backstage-plugin-catalog-history-node/testUtils';
import { HistoryRecordingEntityProvider } from '../../provider/HistoryRecordingEntityProvider';
import { HistoryRecordingCatalogProcessor } from '../../processor/HistoryRecordingCatalogProcessor';
import { reconcile } from '../../reconciler/reconcile';
import { entityToRow } from '../../mapping/entityToRow';
import { metricsJournal, outcomes } from './metricsJournal';

const marker = 'unique-private-provider-ref-payload-error';

function user(name = marker, etag = 'v1'): Entity {
  return {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'User',
    metadata: { name, etag },
    spec: { profile: { displayName: marker } },
  };
}

function unmappable(error: Error): Entity {
  const entity = user();
  Object.defineProperty(entity, 'kind', {
    get: () => {
      throw error;
    },
  });
  return entity;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

async function providerHarness(
  options: {
    enabled?: boolean;
    convertFullToDelta?: boolean;
    forceFullEvery?: { seconds: number };
    failure?: 'create' | 'add' | 'record';
  } = {},
) {
  const journal = metricsJournal(options.failure);
  const store = new InMemoryHistoryStore();
  let wrapped!: EntityProviderConnection;
  const inner = {
    getProviderName: () => marker,
    connect: jest.fn(async (connection: EntityProviderConnection) => {
      wrapped = connection;
    }),
  };
  const connection = { applyMutation: jest.fn(), refresh: jest.fn() };
  const provider = new HistoryRecordingEntityProvider({
    ...options,
    inner,
    store,
    metrics: journal.metrics,
    logger: mockServices.logger.mock(),
  });
  await provider.connect(connection);
  return { ...journal, store, wrapped, connection, inner };
}

function processorHarness(
  failure?: 'create' | 'add' | 'record',
  maxBatchSize = 500,
) {
  const journal = metricsJournal(failure);
  const store = new InMemoryHistoryStore();
  const processor = new HistoryRecordingCatalogProcessor({
    store,
    metrics: journal.metrics,
    logger: mockServices.logger.mock(),
    maxBatchSize,
  });
  const post = (entity: Entity) =>
    processor.postProcessEntity(
      entity,
      { type: 'url', target: 'https://example.com' },
      jest.fn(),
      { get: jest.fn(), set: jest.fn() } as CatalogProcessorCache,
    );
  return { ...journal, store, processor, post };
}

describe('provider capture metrics', () => {
  it.each(['full', 'delta'] as const)(
    'forwards %s first and preserves insert/update/unchanged/delete classifications',
    async type => {
      // Arrange
      const h = await providerHarness();
      const order: string[] = [];
      h.connection.applyMutation.mockImplementation(async () => {
        order.push('forward');
      });
      jest.spyOn(h.store, 'loadCurrentEtags').mockImplementation(async () => {
        order.push('baseline');
        return new Map([
          ['user:default/updated', 'old'],
          ['user:default/unchanged', 'v1'],
          ['user:default/deleted', 'old'],
        ]);
      });
      const record = jest
        .spyOn(h.store, 'recordCycle')
        .mockImplementation(async () => {
          order.push('record');
        });
      const entries = ['inserted', 'updated', 'unchanged'].map(name => ({
        entity: user(name),
        locationKey: marker,
      }));
      const mutation: EntityProviderMutation =
        type === 'full'
          ? { type, entities: entries }
          : {
              type,
              added: entries,
              removed: [{ entityRef: 'User:Default/Deleted' }],
            };

      // Act
      await h.wrapped.applyMutation(mutation);

      // Assert
      expect(order).toEqual(['forward', 'baseline', 'record']);
      expect(h.connection.applyMutation).toHaveBeenCalledTimes(1);
      expect(h.connection.applyMutation).toHaveBeenCalledWith(mutation);
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({
          mutationType: type,
          inserts: [
            expect.objectContaining({ entityRef: 'user:default/inserted' }),
          ],
          updates: [
            expect.objectContaining({ entityRef: 'user:default/updated' }),
          ],
          deletes: ['user:default/deleted'],
          unchangedCount: 1,
          startedAt: expect.any(Date),
          finishedAt: expect.any(Date),
        }),
      );
      expect(
        outcomes(h.measurements, 'provider', {
          operation: 'provider_mutation',
        }),
      ).toEqual(['success']);
      for (const phase of ['forward', 'baseline', 'prepare', 'record']) {
        expect(outcomes(h.measurements, 'provider', { phase })).toEqual([
          'success',
        ]);
      }
      expect(JSON.stringify(h.measurements)).not.toContain(marker);
    },
  );

  it('rethrows the identical forward error without reading or recording history', async () => {
    // Arrange
    const h = await providerHarness();
    const error = new Error(marker);
    h.connection.applyMutation.mockRejectedValue(error);
    const baseline = jest.spyOn(h.store, 'loadCurrentEtags');
    const record = jest.spyOn(h.store, 'recordCycle');

    // Act
    const result = h.wrapped.applyMutation({ type: 'full', entities: [] });

    // Assert
    await expect(result).rejects.toBe(error);
    expect(baseline).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(outcomes(h.measurements, 'provider', { phase: 'forward' })).toEqual([
      'error',
    ]);
    expect(
      outcomes(h.measurements, 'provider', { operation: 'provider_mutation' }),
    ).toEqual(['error']);
    expect(JSON.stringify(h.measurements)).not.toContain(marker);
  });

  it.each(['baseline', 'prepare', 'record'] as const)(
    'swallows %s failure but reports the operation as error',
    async phase => {
      // Arrange
      const h = await providerHarness();
      const error = new Error(marker);
      if (phase === 'baseline')
        jest.spyOn(h.store, 'loadCurrentEtags').mockRejectedValue(error);
      const record = jest.spyOn(h.store, 'recordCycle');
      if (phase === 'record') record.mockRejectedValue(error);
      const entity = phase === 'prepare' ? unmappable(error) : user();

      // Act
      const result = h.wrapped.applyMutation({
        type: 'full',
        entities: [{ entity, locationKey: marker }],
      });

      // Assert
      await expect(result).resolves.toBeUndefined();
      expect(h.connection.applyMutation).toHaveBeenCalledTimes(1);
      expect(record).toHaveBeenCalledTimes(phase === 'record' ? 1 : 0);
      expect(outcomes(h.measurements, 'provider', { phase })).toEqual([
        'error',
      ]);
      expect(
        outcomes(h.measurements, 'provider', {
          operation: 'provider_mutation',
        }),
      ).toEqual(['error']);
      expect(JSON.stringify(h.measurements)).not.toContain(marker);
    },
  );

  it('forwards the original full once and skips recording when conversion baseline fails', async () => {
    // Arrange
    const h = await providerHarness({ convertFullToDelta: true });
    jest
      .spyOn(h.store, 'loadCurrentEtags')
      .mockRejectedValue(new Error(marker));
    const record = jest.spyOn(h.store, 'recordCycle');
    const mutation: EntityProviderMutation = {
      type: 'full',
      entities: [{ entity: user(), locationKey: marker }],
    };

    // Act
    await h.wrapped.applyMutation(mutation);

    // Assert
    expect(h.connection.applyMutation).toHaveBeenCalledTimes(1);
    expect(h.connection.applyMutation.mock.calls[0][0]).toBe(mutation);
    expect(record).not.toHaveBeenCalled();
    expect(outcomes(h.measurements, 'provider', { phase: 'baseline' })).toEqual(
      ['error'],
    );
    expect(outcomes(h.measurements, 'provider', { phase: 'forward' })).toEqual([
      'success',
    ]);
    expect(
      outcomes(h.measurements, 'provider', { operation: 'provider_mutation' }),
    ).toEqual(['error']);
  });

  it('hands the raw connection through when disabled without mutation measurements', async () => {
    // Arrange
    const h = await providerHarness({ enabled: false });
    const baseline = jest.spyOn(h.store, 'loadCurrentEtags');

    // Act
    await h.wrapped.applyMutation({ type: 'full', entities: [] });

    // Assert
    expect(h.wrapped).toBe(h.connection);
    expect(baseline).not.toHaveBeenCalled();
    expect(h.measurements).toEqual([]);
  });

  it.each(['create', 'add', 'record'] as const)(
    'does not repeat work or change forward error identity when SDK %s throws',
    async failure => {
      // Arrange
      const h = await providerHarness({ failure });
      const record = jest.spyOn(h.store, 'recordCycle');
      const error = new Error(marker);

      // Act
      await h.wrapped.applyMutation({ type: 'full', entities: [] });
      h.connection.applyMutation.mockRejectedValue(error);
      const rejected = h.wrapped.applyMutation({ type: 'full', entities: [] });

      // Assert
      await expect(rejected).rejects.toBe(error);
      expect(record).toHaveBeenCalledTimes(1);
      expect(h.connection.applyMutation).toHaveBeenCalledTimes(2);
    },
  );
});

describe('processor capture metrics', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('serializes same-entity classification behind one pending baseline seed', async () => {
    // Arrange
    const h = processorHarness();
    const gate =
      deferred<Awaited<ReturnType<typeof h.store.loadAllCurrentEtags>>>();
    const baseline = jest
      .spyOn(h.store, 'loadAllCurrentEtags')
      .mockReturnValue(gate.promise);
    const entity = user();

    // Act
    const first = h.post(entity);
    const second = h.post(entity);
    gate.resolve(new Map());
    const returned = await Promise.all([first, second]);
    await h.processor.stop();

    // Assert - no new await splits read/classify/queue/cache writes.
    expect(returned).toEqual([entity, entity]);
    expect(baseline).toHaveBeenCalledTimes(1);
    expect(baseline).toHaveBeenCalledWith({ source: 'processing' });
    expect(h.store.cycles).toHaveLength(1);
    expect(h.store.cycles[0]).toMatchObject({
      inserts: [entityToRow(entity)],
      updates: [],
      unchangedCount: 1,
    });
    expect(
      outcomes(h.measurements, 'processing', {
        operation: 'processing_entity',
      }),
    ).toEqual(['success', 'success']);
    expect(
      outcomes(h.measurements, 'processing', { operation: 'processing_flush' }),
    ).toEqual(['success']);
    expect(JSON.stringify(h.measurements)).not.toContain(marker);
  });

  it.each(['baseline', 'prepare'] as const)(
    'returns the entity on %s failure and reports error without a flush',
    async phase => {
      // Arrange
      const h = processorHarness();
      const error = new Error(marker);
      if (phase === 'baseline')
        jest.spyOn(h.store, 'loadAllCurrentEtags').mockRejectedValue(error);
      const entity = phase === 'prepare' ? unmappable(error) : user();

      // Act
      const result = await h.post(entity);
      await h.processor.stop();

      // Assert
      expect(result).toBe(entity);
      expect(h.store.cycles).toEqual([]);
      expect(outcomes(h.measurements, 'processing', { phase })).toContain(
        'error',
      );
      expect(
        outcomes(h.measurements, 'processing', {
          operation: 'processing_entity',
        }),
      ).toEqual(['error']);
      expect(
        outcomes(h.measurements, 'processing', {
          operation: 'processing_flush',
        }),
      ).toEqual([]);
    },
  );

  it('reports unchanged observations as successful without measuring empty flushes', async () => {
    // Arrange
    const h = processorHarness();
    const entity = user();
    jest
      .spyOn(h.store, 'loadAllCurrentEtags')
      .mockResolvedValue(
        new Map([
          [
            entityToRow(entity).entityRef,
            { etag: 'v1', provider: 'processing' },
          ],
        ]),
      );

    // Act
    const result = await h.post(entity);
    await h.processor.flush();
    await h.processor.stop();

    // Assert
    expect(result).toBe(entity);
    expect(h.store.cycles).toEqual([]);
    expect(
      outcomes(h.measurements, 'processing', {
        operation: 'processing_entity',
      }),
    ).toEqual(['success']);
    expect(
      outcomes(h.measurements, 'processing', { operation: 'processing_flush' }),
    ).toEqual([]);
    expect(outcomes(h.measurements, 'processing', { phase: 'record' })).toEqual(
      [],
    );
  });

  it('reports a swallowed flush error separately and restores etags for recapture', async () => {
    // Arrange
    const h = processorHarness(undefined, 1);
    const record = jest
      .spyOn(h.store, 'recordCycle')
      .mockRejectedValueOnce(new Error(marker));
    const entity = user();

    // Act
    const first = await h.post(entity);
    const second = await h.post(entity);
    await h.processor.stop();

    // Assert - entity success is not proof that the batch persisted.
    expect(first).toBe(entity);
    expect(second).toBe(entity);
    expect(record).toHaveBeenCalledTimes(2);
    expect(record.mock.calls.map(([cycle]) => cycle.inserts)).toEqual([
      [entityToRow(entity)],
      [entityToRow(entity)],
    ]);
    expect(h.store.cycles).toHaveLength(1);
    expect(
      outcomes(h.measurements, 'processing', {
        operation: 'processing_entity',
      }),
    ).toEqual(['success', 'success']);
    expect(
      outcomes(h.measurements, 'processing', { operation: 'processing_flush' }),
    ).toEqual(['error', 'success']);
    expect(outcomes(h.measurements, 'processing', { phase: 'record' })).toEqual(
      ['error', 'success'],
    );
    expect(JSON.stringify(h.measurements)).not.toContain(marker);
  });

  it('stop drains rows queued while the first record is in flight', async () => {
    // Arrange
    const h = processorHarness();
    const gate = deferred<void>();
    const entered = deferred<void>();
    const record = jest
      .spyOn(h.store, 'recordCycle')
      .mockImplementationOnce(async () => {
        entered.resolve();
        await gate.promise;
      });
    await h.post(user('first'));

    // Act
    const flush = h.processor.flush();
    await entered.promise;
    await h.post(user('second'));
    const stopped = h.processor.stop();
    gate.resolve();
    await Promise.all([flush, stopped]);

    // Assert
    expect(record).toHaveBeenCalledTimes(2);
    expect(
      record.mock.calls.map(([cycle]) => cycle.inserts.map(row => row.name)),
    ).toEqual([['first'], ['second']]);
    expect(
      outcomes(h.measurements, 'processing', { operation: 'processing_flush' }),
    ).toEqual(['success', 'success']);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(['create', 'add', 'record'] as const)(
    'keeps state, return identity, and failed-flush recovery when SDK %s throws',
    async failure => {
      // Arrange
      const h = processorHarness(failure, 1);
      const record = jest
        .spyOn(h.store, 'recordCycle')
        .mockRejectedValueOnce(new Error(marker));
      const entity = user();

      // Act
      const first = await h.post(entity);
      const second = await h.post(entity);
      await h.processor.stop();

      // Assert
      expect(first).toBe(entity);
      expect(second).toBe(entity);
      expect(record).toHaveBeenCalledTimes(2);
      expect(h.store.cycles[0].inserts).toEqual([entityToRow(entity)]);
      expect(jest.getTimerCount()).toBe(0);
    },
  );
});

describe('reconciler capture metrics', () => {
  it.each([false, true])(
    'records success for normal and heartbeat cycles (heartbeat=%s)',
    async heartbeat => {
      // Arrange
      const h = metricsJournal();
      const store = new InMemoryHistoryStore();
      const entity = user();
      const baseline = jest
        .spyOn(store, 'loadAllCurrentEtags')
        .mockResolvedValue(
          heartbeat
            ? new Map([
                [
                  entityToRow(entity).entityRef,
                  { etag: 'v1', provider: 'reconciler' },
                ],
              ])
            : new Map(),
        );
      const fetcher = { getEntities: jest.fn().mockResolvedValue([entity]) };

      // Act
      await reconcile({
        ...h,
        store,
        fetcher,
        logger: mockServices.logger.mock(),
      });

      // Assert
      expect(baseline).toHaveBeenCalledWith({ source: 'reconciler' });
      expect(store.cycles).toHaveLength(1);
      expect(store.cycles[0]).toMatchObject({
        provider: 'reconciler',
        source: 'reconciler',
        mutationType: 'full',
        inserts: heartbeat ? [] : [entityToRow(entity)],
        updates: [],
        deletes: [],
        unchangedCount: heartbeat ? 1 : 0,
        startedAt: expect.any(Date),
        finishedAt: expect.any(Date),
      });
      expect(
        outcomes(h.measurements, 'reconciler', { operation: 'reconcile' }),
      ).toEqual(['success']);
      for (const phase of ['fetch', 'baseline', 'prepare', 'record']) {
        expect(outcomes(h.measurements, 'reconciler', { phase })).toContain(
          'success',
        );
      }
      expect(JSON.stringify(h.measurements)).not.toContain(marker);
    },
  );

  it.each(['fetch', 'baseline', 'prepare', 'record'] as const)(
    'rethrows the identical %s error with matching phase and operation outcomes',
    async phase => {
      // Arrange
      const h = metricsJournal();
      const store = new InMemoryHistoryStore();
      const error = new Error(marker);
      const fetcher = {
        getEntities: jest
          .fn()
          .mockResolvedValue([
            phase === 'prepare' ? unmappable(error) : user(),
          ]),
      };
      if (phase === 'fetch') fetcher.getEntities.mockRejectedValue(error);
      if (phase === 'baseline')
        jest.spyOn(store, 'loadAllCurrentEtags').mockRejectedValue(error);
      const record = jest.spyOn(store, 'recordCycle');
      if (phase === 'record') record.mockRejectedValue(error);

      // Act
      const result = reconcile({
        ...h,
        store,
        fetcher,
        logger: mockServices.logger.mock(),
      });

      // Assert
      await expect(result).rejects.toBe(error);
      expect(record).toHaveBeenCalledTimes(phase === 'record' ? 1 : 0);
      expect(outcomes(h.measurements, 'reconciler', { phase })).toContain(
        'error',
      );
      expect(
        outcomes(h.measurements, 'reconciler', { operation: 'reconcile' }),
      ).toEqual(['error']);
      expect(JSON.stringify(h.measurements)).not.toContain(marker);
    },
  );

  it.each(['create', 'add', 'record'] as const)(
    'preserves success, error identity, and work counts when SDK %s throws',
    async failure => {
      // Arrange
      const h = metricsJournal(failure);
      const store = new InMemoryHistoryStore();
      const fetcher = { getEntities: jest.fn().mockResolvedValue([user()]) };
      const record = jest.spyOn(store, 'recordCycle');
      const error = new Error(marker);
      const options = {
        ...h,
        store,
        fetcher,
        logger: mockServices.logger.mock(),
      };

      // Act
      await reconcile(options);
      record.mockRejectedValueOnce(error);
      const result = reconcile(options);

      // Assert
      await expect(result).rejects.toBe(error);
      expect(fetcher.getEntities).toHaveBeenCalledTimes(2);
      expect(record).toHaveBeenCalledTimes(2);
      expect(store.cycles).toHaveLength(1);
    },
  );

  it('still records for manual callers without metrics', async () => {
    // Arrange
    const store = new InMemoryHistoryStore();
    const fetcher = { getEntities: jest.fn().mockResolvedValue([]) };

    // Act
    await reconcile({ store, fetcher, logger: mockServices.logger.mock() });

    // Assert
    expect(store.cycles).toHaveLength(1);
    expect(store.cycles[0]).toMatchObject({
      inserts: [],
      updates: [],
      deletes: [],
    });
  });
});

describe('capture cycle boundaries with metrics enabled', () => {
  const epoch = new Date('2026-07-05T00:00:00Z').getTime();
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(epoch);
  });
  afterEach(() => jest.useRealTimers());

  it('keeps provider cycle start after forwarding and finish before record', async () => {
    // Arrange
    const h = await providerHarness();
    h.connection.applyMutation.mockImplementation(async () => {
      jest.setSystemTime(epoch + 1000);
    });
    jest.spyOn(h.store, 'loadCurrentEtags').mockImplementation(async () => {
      jest.setSystemTime(epoch + 2000);
      return new Map();
    });

    // Act
    await h.wrapped.applyMutation({ type: 'full', entities: [] });

    // Assert
    expect(h.store.cycles[0].startedAt).toEqual(new Date(epoch + 1000));
    expect(h.store.cycles[0].finishedAt).toEqual(new Date(epoch + 2000));
  });

  it('keeps reconcile cycle start before fetch and finish before record', async () => {
    // Arrange
    const h = metricsJournal();
    const store = new InMemoryHistoryStore();
    const fetcher = {
      getEntities: jest.fn(async () => {
        jest.setSystemTime(epoch + 1000);
        return [];
      }),
    };
    jest.spyOn(store, 'loadAllCurrentEtags').mockImplementation(async () => {
      jest.setSystemTime(epoch + 2000);
      return new Map();
    });

    // Act
    await reconcile({
      ...h,
      store,
      fetcher,
      logger: mockServices.logger.mock(),
    });

    // Assert
    expect(store.cycles[0].startedAt).toEqual(new Date(epoch));
    expect(store.cycles[0].finishedAt).toEqual(new Date(epoch + 2000));
  });

  it('preserves the first full and exact force-full interval without changing history mutation types', async () => {
    // Arrange
    const h = await providerHarness({
      convertFullToDelta: true,
      forceFullEvery: { seconds: 10 },
    });
    jest
      .spyOn(h.store, 'loadCurrentEtags')
      .mockResolvedValue(new Map([['user:default/removed', 'v1']]));
    const mutation: EntityProviderMutation = {
      type: 'full',
      entities: [{ entity: user(), locationKey: marker }],
    };

    // Act
    await h.wrapped.applyMutation(mutation);
    jest.setSystemTime(epoch + 9999);
    await h.wrapped.applyMutation(mutation);
    jest.setSystemTime(epoch + 10000);
    await h.wrapped.applyMutation(mutation);

    // Assert
    expect(
      h.connection.applyMutation.mock.calls.map(
        ([forwarded]) => forwarded.type,
      ),
    ).toEqual(['full', 'delta', 'full']);
    expect(h.connection.applyMutation.mock.calls[1][0]).toEqual({
      type: 'delta',
      added: mutation.entities,
      removed: [{ entityRef: 'user:default/removed' }],
    });
    expect(h.store.cycles.map(cycle => cycle.mutationType)).toEqual([
      'full',
      'full',
      'full',
    ]);
    expect(
      outcomes(h.measurements, 'provider', { operation: 'provider_mutation' }),
    ).toEqual(['success', 'success', 'success']);
  });
});
