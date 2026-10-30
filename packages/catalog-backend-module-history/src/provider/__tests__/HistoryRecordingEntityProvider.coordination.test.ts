import { mockServices } from '@backstage/backend-test-utils';
import type { Entity } from '@backstage/catalog-model';
import type {
  EntityProvider,
  EntityProviderConnection,
  EntityProviderMutation,
} from '@backstage/plugin-catalog-node';
import type {
  CycleInput,
  HistoryStore,
} from '@kunickiaj/backstage-plugin-catalog-history-node';
import { InMemoryHistoryStore } from '@kunickiaj/backstage-plugin-catalog-history-node/testUtils';
import { HistoryRecordingEntityProvider } from '../HistoryRecordingEntityProvider';
import { entityToRow } from '../../mapping/entityToRow';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

function entity(name: string, etag: string): Entity {
  return {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'User',
    metadata: { name, namespace: 'default', etag },
  };
}

function full(etag: string): EntityProviderMutation {
  return {
    type: 'full',
    entities: [{ entity: entity('alice', etag), locationKey: 'test:alice' }],
  };
}

async function setup(
  store: HistoryStore,
  options: { enabled?: boolean; convertFullToDelta?: boolean } = {},
) {
  let wrapped!: EntityProviderConnection;
  const inner: EntityProvider = {
    getProviderName: () => 'directory',
    connect: async connection => {
      wrapped = connection;
    },
  };
  const logger = mockServices.logger.mock();
  const connection: EntityProviderConnection = {
    applyMutation: jest.fn().mockResolvedValue(undefined),
    refresh: jest.fn().mockResolvedValue(undefined),
  };
  const wrapper = new HistoryRecordingEntityProvider({
    inner,
    store,
    logger,
    ...options,
  });
  await wrapper.connect(connection);
  return { wrapped, connection, logger };
}

function cycle(source: CycleInput['source'], etag: string): CycleInput {
  return {
    cycleId: `seed-${source}`,
    provider: 'directory',
    source,
    mutationType: 'full',
    startedAt: new Date('2026-01-01T00:00:00Z'),
    finishedAt: new Date('2026-01-01T00:00:00Z'),
    inserts: [
      entityToRow(entity('alice', etag)),
      entityToRow(entity(source, etag)),
    ],
    updates: [],
    deletes: [],
    unchangedCount: 0,
  };
}

describe('HistoryRecordingEntityProvider store coordination', () => {
  it.each(['forward', 'record'] as const)(
    'releases the shared provider exclusion after a failed %s',
    async failurePoint => {
      // Arrange: a different wrapper is already queued behind the failed call.
      const store = new InMemoryHistoryStore();
      const first = await setup(store);
      const second = await setup(store);
      const failure = new Error(`${failurePoint} unavailable`);
      if (failurePoint === 'forward') {
        (first.connection.applyMutation as jest.Mock).mockRejectedValueOnce(
          failure,
        );
      } else {
        jest.spyOn(store, 'recordCycle').mockRejectedValueOnce(failure);
      }

      // Act: attach the rejection handler before the queued work can run.
      const firstResult = first.wrapped
        .applyMutation(full('old'))
        .catch(error => error);
      const secondResult = second.wrapped.applyMutation(full('new'));
      const result = await firstResult;
      await secondResult;

      // Assert: a failed forward never records and failed recording never retries.
      expect(result).toBe(failurePoint === 'forward' ? failure : undefined);
      expect(first.connection.applyMutation).toHaveBeenCalledTimes(1);
      expect(second.connection.applyMutation).toHaveBeenCalledTimes(1);
      expect(store.cycles).toHaveLength(1);
      expect(store.cycles[0].inserts[0].etag).toBe('new');
      expect(first.logger.error.mock.calls.map(([, error]) => error)).toEqual(
        failurePoint === 'record' ? [failure] : [],
      );
    },
  );

  it('keeps sequential wrappers consistent with the catalog', async () => {
    // Arrange: the same provider restarts with the same store.
    const store = new InMemoryHistoryStore();
    const first = await setup(store);
    const second = await setup(store);

    // Act
    await first.wrapped.applyMutation(full('old'));
    await second.wrapped.applyMutation(full('new'));

    // Assert
    expect(first.connection.applyMutation).toHaveBeenCalledWith(full('old'));
    expect(second.connection.applyMutation).toHaveBeenCalledWith(full('new'));
    expect(store.cycles[0].inserts[0].etag).toBe('old');
    expect(store.cycles[1].updates[0].etag).toBe('new');
    expect(
      await store.loadCurrentEtags('directory', { source: 'provider' }),
    ).toEqual(new Map([['user:default/alice', 'new']]));
  });

  it.each([false, true])(
    'uses the exact raw connection and never touches storage when disabled (conversion %s)',
    async convertFullToDelta => {
      // Arrange: even storage initialization must remain lazy when disabled.
      const store = new InMemoryHistoryStore();
      const coordinate = jest.spyOn(store, 'withProviderMutation');
      const load = jest.spyOn(store, 'loadCurrentEtags');
      const record = jest.spyOn(store, 'recordCycle');
      const ready = jest.fn().mockRejectedValue(new Error('must stay lazy'));
      Object.assign(store, { ensureReady: ready });
      const { wrapped, connection } = await setup(store, {
        enabled: false,
        convertFullToDelta,
      });
      const mutation = full('new');

      // Act
      await wrapped.applyMutation(mutation);

      // Assert
      expect(wrapped).toBe(connection);
      expect(connection.applyMutation).toHaveBeenCalledTimes(1);
      expect((connection.applyMutation as jest.Mock).mock.calls[0][0]).toBe(
        mutation,
      );
      expect(coordinate).not.toHaveBeenCalled();
      expect(load).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
      expect(ready).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'forwards unchanged without reading or recording when coordination is unavailable (conversion %s)',
    async convertFullToDelta => {
      // Arrange: legacy stores cannot safely order provider history.
      const store: HistoryStore = {
        loadCurrentEtags: jest.fn(),
        loadAllCurrentEtags: jest.fn(),
        recordCycle: jest.fn(),
      };
      const { wrapped, connection, logger } = await setup(store, {
        convertFullToDelta,
      });
      const mutation = full('new');

      // Act
      await wrapped.applyMutation(mutation);

      // Assert
      expect(connection.applyMutation).toHaveBeenCalledTimes(1);
      expect((connection.applyMutation as jest.Mock).mock.calls[0][0]).toBe(
        mutation,
      );
      expect(store.loadCurrentEtags).not.toHaveBeenCalled();
      expect(store.recordCycle).not.toHaveBeenCalled();
      expect(
        [...logger.warn.mock.calls, ...logger.error.mock.calls]
          .flat()
          .join(' '),
      ).toMatch(/coordinat/i);
    },
  );

  it.each([false, true])(
    'forwards once and recovers when coordination fails before its callback (conversion %s)',
    async convertFullToDelta => {
      // Arrange
      const store = new InMemoryHistoryStore();
      const failure = new Error('lock unavailable');
      jest.spyOn(store, 'withProviderMutation').mockRejectedValueOnce(failure);
      const load = jest.spyOn(store, 'loadCurrentEtags');
      const record = jest.spyOn(store, 'recordCycle');
      const { wrapped, connection, logger } = await setup(store, {
        convertFullToDelta,
      });
      const mutation = full('old');

      // Act
      await wrapped.applyMutation(mutation);

      // Assert: fallback cannot convert or record without the exclusion.
      expect(connection.applyMutation).toHaveBeenCalledTimes(1);
      expect((connection.applyMutation as jest.Mock).mock.calls[0][0]).toBe(
        mutation,
      );
      expect(load).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(expect.any(String), failure);
      await wrapped.applyMutation(full('new'));
      expect(connection.applyMutation).toHaveBeenCalledTimes(2);
      expect(store.cycles).toHaveLength(1);
      expect(store.cycles[0].inserts[0].etag).toBe('new');
    },
  );

  it.each(['disabled', 'unavailable'] as const)(
    'preserves the catalog rejection when coordination is %s',
    async mode => {
      // Arrange: passthrough must preserve rejection identity as well as input.
      const store: HistoryStore = {
        loadCurrentEtags: jest.fn(),
        loadAllCurrentEtags: jest.fn(),
        recordCycle: jest.fn(),
      };
      const { wrapped, connection } = await setup(store, {
        enabled: mode !== 'disabled',
        convertFullToDelta: true,
      });
      const failure = new Error('catalog rejected passthrough');
      (connection.applyMutation as jest.Mock).mockRejectedValueOnce(failure);
      const mutation = full('new');

      // Act
      const result = wrapped.applyMutation(mutation);

      // Assert
      await expect(result).rejects.toBe(failure);
      expect(connection.applyMutation).toHaveBeenCalledTimes(1);
      expect((connection.applyMutation as jest.Mock).mock.calls[0][0]).toBe(
        mutation,
      );
      expect(store.loadCurrentEtags).not.toHaveBeenCalled();
      expect(store.recordCycle).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'preserves catalog rejection when forwarding after coordination fails (conversion %s)',
    async convertFullToDelta => {
      // Arrange
      const store = new InMemoryHistoryStore();
      jest
        .spyOn(store, 'withProviderMutation')
        .mockRejectedValueOnce(new Error('lock failed'));
      const { wrapped, connection } = await setup(store, {
        convertFullToDelta,
      });
      const failure = new Error('catalog rejected fallback');
      (connection.applyMutation as jest.Mock).mockRejectedValueOnce(failure);

      // Act
      const result = wrapped.applyMutation(full('new'));

      // Assert
      await expect(result).rejects.toBe(failure);
      expect(connection.applyMutation).toHaveBeenCalledTimes(1);
      expect(store.cycles).toHaveLength(0);
    },
  );

  it.each([false, true])(
    'never repeats the catalog write when coordination fails after callback completion (conversion %s)',
    async convertFullToDelta => {
      // Arrange: emulate a transaction whose callback succeeds but commit fails.
      const store = new InMemoryHistoryStore();
      const coordinate = store.withProviderMutation.bind(store);
      const failure = new Error('commit failed');
      jest
        .spyOn(store, 'withProviderMutation')
        .mockImplementationOnce(async (provider, work) => {
          await coordinate(provider, work);
          throw failure;
        });
      const { wrapped, connection, logger } = await setup(store, {
        convertFullToDelta,
      });
      const mutation = full('new');

      // Act
      await wrapped.applyMutation(mutation);

      // Assert: a post-forward storage failure must not retry the mutation.
      expect(connection.applyMutation).toHaveBeenCalledTimes(1);
      expect((connection.applyMutation as jest.Mock).mock.calls[0][0]).toBe(
        mutation,
      );
      expect(logger.error).toHaveBeenCalledWith(expect.any(String), failure);
    },
  );

  it.each([false, true])(
    'preserves the catalog error even if coordination reports a different failure (conversion %s)',
    async convertFullToDelta => {
      // Arrange: transaction cleanup can replace the callback rejection.
      const store = new InMemoryHistoryStore();
      const coordinate = store.withProviderMutation.bind(store);
      jest
        .spyOn(store, 'withProviderMutation')
        .mockImplementationOnce(async (provider, work) => {
          await coordinate(provider, work).catch(() => undefined);
          throw new Error('transaction cleanup failed');
        });
      const { wrapped, connection } = await setup(store, {
        convertFullToDelta,
      });
      const failure = new Error('catalog rejected mutation');
      (connection.applyMutation as jest.Mock).mockRejectedValueOnce(failure);

      // Act
      const result = wrapped.applyMutation(full('new'));

      // Assert
      await expect(result).rejects.toBe(failure);
      expect(connection.applyMutation).toHaveBeenCalledTimes(1);
      expect(store.cycles).toHaveLength(0);
    },
  );

  it('loads a conversion baseline before forwarding and releases later calls after a read failure', async () => {
    // Arrange
    const store = new InMemoryHistoryStore();
    const started = deferred();
    const release = deferred();
    const failure = new Error('baseline unavailable');
    jest.spyOn(store, 'loadCurrentEtags').mockImplementationOnce(async () => {
      started.resolve();
      await release.promise;
      throw failure;
    });
    const first = await setup(store, { convertFullToDelta: true });
    const second = await setup(store);
    const mutation = full('old');

    // Act
    const pending = first.wrapped.applyMutation(mutation);
    await started.promise;
    const next = second.wrapped.applyMutation(full('new'));
    await new Promise(resolve => setImmediate(resolve));
    const firstCallsWhileBlocked = (first.connection.applyMutation as jest.Mock)
      .mock.calls.length;
    const secondCallsWhileBlocked = (
      second.connection.applyMutation as jest.Mock
    ).mock.calls.length;
    release.resolve();
    await Promise.all([pending, next]);

    // Assert
    expect(firstCallsWhileBlocked).toBe(0);
    expect(secondCallsWhileBlocked).toBe(0);
    expect(first.connection.applyMutation).toHaveBeenCalledTimes(1);
    expect((first.connection.applyMutation as jest.Mock).mock.calls[0][0]).toBe(
      mutation,
    );
    expect(first.logger.error).toHaveBeenCalledTimes(1);
    expect(first.logger.error).toHaveBeenCalledWith(
      expect.any(String),
      failure,
    );
    expect(first.logger.error.mock.calls[0][1]).toBe(failure);
    expect(second.connection.applyMutation).toHaveBeenCalledTimes(1);
    expect(second.connection.applyMutation).toHaveBeenCalledWith(full('new'));
    expect(second.logger.error).not.toHaveBeenCalled();
    expect(store.cycles).toHaveLength(1);
    expect(store.cycles[0].inserts[0].etag).toBe('new');
  });

  it.each([false, true])(
    'ignores processing and reconciler baselines when diffing provider mutations (conversion %s)',
    async convertFullToDelta => {
      // Arrange: other sources contain newer etags and extra references.
      const store = new InMemoryHistoryStore();
      await store.recordCycle(cycle('provider', 'provider-etag'));
      await store.recordCycle(cycle('processing', 'processing-etag'));
      await store.recordCycle(cycle('reconciler', 'reconciler-etag'));
      const { wrapped, connection } = await setup(store, {
        convertFullToDelta,
      });
      const mutation = full('provider-etag');

      // Act
      await wrapped.applyMutation(mutation);

      // Assert: only a provider ref can become a removal or unchanged entity.
      expect(store.cycles[3]).toMatchObject({
        source: 'provider',
        inserts: [],
        updates: [],
        deletes: ['user:default/provider'],
        unchangedCount: 1,
      });
      const expectedForward = convertFullToDelta
        ? {
            type: 'delta',
            added: mutation.type === 'full' ? mutation.entities : [],
            removed: [{ entityRef: 'user:default/provider' }],
          }
        : mutation;
      expect(connection.applyMutation).toHaveBeenCalledWith(expectedForward);
    },
  );

  it('keeps the first provider full intact when only other capture sources have history', async () => {
    // Arrange: another capture source must not enable conversion.
    const store = new InMemoryHistoryStore();
    await store.recordCycle(cycle('processing', 'processed'));
    await store.recordCycle(cycle('reconciler', 'reconciled'));
    const { wrapped, connection } = await setup(store, {
      convertFullToDelta: true,
    });
    const mutation = full('provider');

    // Act
    await wrapped.applyMutation(mutation);

    // Assert
    expect((connection.applyMutation as jest.Mock).mock.calls[0][0]).toBe(
      mutation,
    );
    expect(store.cycles[2]).toMatchObject({
      source: 'provider',
      updates: [],
      deletes: [],
      unchangedCount: 0,
    });
    expect(store.cycles[2].inserts[0].etag).toBe('provider');
  });
});
