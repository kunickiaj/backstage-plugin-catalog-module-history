import {
  createLazyHistoryStore,
  type LoadedHistoryStore,
} from '../createLazyHistoryStore';
import type { ProviderMutationStore } from '@kunickiaj/backstage-plugin-catalog-history-node';

function fakeStore(): jest.Mocked<LoadedHistoryStore> {
  const read = () => jest.fn().mockResolvedValue({ items: [] });
  return {
    query: {
      getEntityTimeline: read(),
      getEntityVersions: read(),
      getEntityVersion: read(),
      getEntityAsOf: read(),
      getEntityDiff: read(),
      getChangeFeed: read(),
      getProviders: read(),
      getEntities: read(),
      getKinds: read(),
      listCycles: read(),
      getCycle: read(),
    },
    ensureReady: jest.fn().mockResolvedValue(undefined),
    shutdown: jest.fn().mockResolvedValue(undefined),
    loadCurrentEtags: jest.fn().mockResolvedValue(new Map()),
    loadAllCurrentEtags: jest.fn().mockResolvedValue(new Map()),
    recordCycle: jest.fn().mockResolvedValue(undefined),
    planRetention: jest.fn().mockResolvedValue({}),
    applyRetention: jest.fn().mockResolvedValue({}),
  } as unknown as jest.Mocked<LoadedHistoryStore>;
}

describe('createLazyHistoryStore', () => {
  it('loads once and forwards provider coordination with the scoped store and result', async () => {
    // Arrange
    const inner = fakeStore();
    const scoped = {
      loadCurrentEtags: jest.fn().mockResolvedValue(new Map([['ref', 'etag']])),
      recordCycle: jest.fn().mockResolvedValue(undefined),
    };
    inner.withProviderMutation = jest.fn(
      async <T>(
        _provider: string,
        callback: (transaction: ProviderMutationStore) => Promise<T>,
      ): Promise<T> => callback(scoped),
    ) as jest.MockedFunction<
      NonNullable<LoadedHistoryStore['withProviderMutation']>
    >;
    const load = jest.fn(async () => inner);
    const store = createLazyHistoryStore(load);
    const work = jest.fn(async transaction => {
      await transaction.recordCycle({});
      return 'committed';
    });
    // Act
    const result = await store.withProviderMutation!('provider-a', work);
    // Assert
    expect(result).toBe('committed');
    expect(load).toHaveBeenCalledTimes(1);
    expect(inner.withProviderMutation).toHaveBeenCalledWith('provider-a', work);
    expect(work).toHaveBeenCalledWith(scoped);
    expect(scoped.recordCycle).toHaveBeenCalledTimes(1);
  });

  it('propagates coordination failures without running the callback outside the lock', async () => {
    // Arrange
    const inner = fakeStore();
    inner.withProviderMutation = jest
      .fn()
      .mockRejectedValue(new Error('lock unavailable'));
    const store = createLazyHistoryStore(async () => inner);
    const work = jest.fn();
    // Act / Assert
    await expect(store.withProviderMutation!('p', work)).rejects.toThrow(
      'lock unavailable',
    );
    expect(work).not.toHaveBeenCalled();
    expect(inner.recordCycle).not.toHaveBeenCalled();
  });

  it('rejects coordination when the loaded store lacks the optional capability', async () => {
    // Arrange
    const inner = fakeStore();
    const store = createLazyHistoryStore(async () => inner);
    const work = jest.fn();
    // Act / Assert
    await expect(store.withProviderMutation!('p', work)).rejects.toThrow(
      /coordination/,
    );
    expect(work).not.toHaveBeenCalled();
  });

  it('does not load until a read, write, or ensureReady call', async () => {
    // Arrange
    const load = jest.fn();
    // Act
    const store = createLazyHistoryStore(load);
    await store.shutdown();
    // Assert: resolving and shutting down an unused store opens nothing.
    expect(store.query.getEntityTimeline).toEqual(expect.any(Function));
    expect(load).not.toHaveBeenCalled();
  });

  it('shares one load across concurrent first calls', async () => {
    // Arrange
    const inner = fakeStore();
    let release!: () => void;
    const load = jest.fn(
      () =>
        new Promise<LoadedHistoryStore>(resolve => {
          release = () => resolve(inner);
        }),
    );
    const store = createLazyHistoryStore(load);
    // Act
    const calls = Promise.all([
      store.ensureReady(),
      store.loadCurrentEtags('p'),
      store.query.getEntityVersions({ entityRef: 'user:default/a' } as never),
      store.recordCycle({} as never),
    ]);
    release();
    await calls;
    // Assert
    expect(load).toHaveBeenCalledTimes(1);
    expect(inner.ensureReady).toHaveBeenCalledTimes(1);
    expect(inner.loadCurrentEtags).toHaveBeenCalledWith('p', undefined);
    expect(inner.query.getEntityVersions).toHaveBeenCalledTimes(1);
    expect(inner.recordCycle).toHaveBeenCalledTimes(1);
  });

  it('rejects every waiter on a failed load and retries on the next call', async () => {
    // Arrange
    const inner = fakeStore();
    const load = jest
      .fn<Promise<LoadedHistoryStore>, []>()
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValue(inner);
    const store = createLazyHistoryStore(load);
    // Act
    const first = await Promise.allSettled([
      store.ensureReady(),
      store.loadAllCurrentEtags(),
    ]);
    await store.ensureReady();
    // Assert
    expect(first.map(r => r.status)).toEqual(['rejected', 'rejected']);
    expect(load).toHaveBeenCalledTimes(2);
    expect(inner.ensureReady).toHaveBeenCalledTimes(1);
  });

  it('forwards every query method to the loaded store', async () => {
    // Arrange
    const inner = fakeStore();
    const store = createLazyHistoryStore(async () => inner);
    const names = Object.keys(inner.query) as Array<
      keyof LoadedHistoryStore['query']
    >;
    // Act
    for (const name of names) {
      await (store.query[name] as (r: unknown) => Promise<unknown>)({ name });
    }
    // Assert
    for (const name of names) {
      expect(inner.query[name]).toHaveBeenCalledWith({ name });
    }
  });

  it('forwards retention methods to the loaded store', async () => {
    // Arrange
    const inner = fakeStore();
    const store = createLazyHistoryStore(async () => inner);
    const cutoff = new Date('2026-01-01T00:00:00Z');
    const signal = new AbortController().signal;
    // Act
    await store.planRetention({ cutoff });
    await store.applyRetention({ cutoff, batchSize: 10, signal });
    // Assert
    expect(inner.planRetention).toHaveBeenCalledWith({ cutoff });
    expect(inner.applyRetention).toHaveBeenCalledWith({
      cutoff,
      batchSize: 10,
      signal,
    });
  });

  it('runs hooks newest first before shutting down the loaded store once', async () => {
    // Arrange
    const order: string[] = [];
    const inner = fakeStore();
    inner.shutdown = jest.fn(async () => {
      order.push('inner');
    });
    const store = createLazyHistoryStore(async () => inner);
    await store.ensureReady();
    store.addShutdownHook(async () => {
      order.push('first');
    });
    store.addShutdownHook(async () => {
      order.push('second');
    });
    // Act
    await Promise.all([store.shutdown(), store.shutdown()]);
    await store.shutdown();
    // Assert
    expect(order).toEqual(['second', 'first', 'inner']);
  });

  it('lets a shutdown hook load the store and then releases it', async () => {
    // Arrange: a buffered flush may be the first use of the store.
    const inner = fakeStore();
    const store = createLazyHistoryStore(async () => inner);
    store.addShutdownHook(() => store.recordCycle({} as never));
    // Act
    await store.shutdown();
    // Assert
    expect(inner.recordCycle).toHaveBeenCalledTimes(1);
    expect(inner.shutdown).toHaveBeenCalledTimes(1);
  });

  it('releases the loaded store and refuses new loads when a hook fails', async () => {
    // Arrange
    const inner = fakeStore();
    const load = jest.fn(async () => inner);
    const store = createLazyHistoryStore(load);
    await store.ensureReady();
    store.addShutdownHook(async () => {
      throw new Error('flush failed');
    });
    // Act
    await expect(store.shutdown()).rejects.toThrow('flush failed');
    // Assert
    expect(inner.shutdown).toHaveBeenCalledTimes(1);
    load.mockClear();
    await expect(store.recordCycle({} as never)).resolves.toBeUndefined();
    expect(load).not.toHaveBeenCalled();
  });

  it('refuses to start a new load after shutdown', async () => {
    // Arrange
    const load = jest.fn();
    const store = createLazyHistoryStore(load);
    await store.shutdown();
    // Act / Assert
    await expect(store.ensureReady()).rejects.toThrow(/shut down/);
    expect(load).not.toHaveBeenCalled();
  });

  it('waits for an in-flight load during shutdown and releases its store', async () => {
    // Arrange
    const inner = fakeStore();
    let release!: () => void;
    const store = createLazyHistoryStore(
      () =>
        new Promise<LoadedHistoryStore>(resolve => {
          release = () => resolve(inner);
        }),
    );
    const ready = store.ensureReady();
    // Act
    const stopped = store.shutdown();
    release();
    await Promise.all([ready, stopped]);
    // Assert
    expect(inner.shutdown).toHaveBeenCalledTimes(1);
  });
});
