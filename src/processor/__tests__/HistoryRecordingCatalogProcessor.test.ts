import type { Entity } from '@backstage/catalog-model';
import { mockServices } from '@backstage/backend-test-utils';
import type {
  CatalogProcessorCache,
  CatalogProcessorEmit,
  LocationSpec,
} from '@backstage/plugin-catalog-node';
import { entityToRow } from '../../mapping/entityToRow';
import { InMemoryHistoryStore } from '../../store/__tests__/InMemoryHistoryStore';
import { HistoryRecordingCatalogProcessor } from '../HistoryRecordingCatalogProcessor';

const location: LocationSpec = {
  type: 'url',
  target: 'https://example.com',
};

function user(name: string, etag: string): Entity {
  return {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'User',
    metadata: { name, namespace: 'default', etag },
    spec: { profile: { displayName: name } },
  };
}

function emit(): CatalogProcessorEmit {
  return jest.fn() as CatalogProcessorEmit;
}

function cache(): CatalogProcessorCache {
  return {
    get: jest.fn(),
    set: jest.fn(),
  } as unknown as CatalogProcessorCache;
}

async function postProcess(
  processor: HistoryRecordingCatalogProcessor,
  entity: Entity,
): Promise<Entity> {
  return processor.postProcessEntity(entity, location, emit(), cache());
}

async function recordExisting(
  store: InMemoryHistoryStore,
  entity: Entity,
  source: 'provider' | 'processing' = 'processing',
): Promise<void> {
  await store.recordCycle({
    cycleId: `${source}-${entity.metadata.name}-${entity.metadata.etag}`,
    provider: source,
    source,
    mutationType: 'delta',
    startedAt: new Date('2026-07-05T00:00:00Z'),
    finishedAt: new Date('2026-07-05T00:00:01Z'),
    inserts: [entityToRow(entity)],
    updates: [],
    deletes: [],
    unchangedCount: 0,
  });
}

describe('HistoryRecordingCatalogProcessor', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('returns the exact same entity object it was given', async () => {
    const store = new InMemoryHistoryStore();
    const processor = new HistoryRecordingCatalogProcessor({
      store,
      logger: mockServices.logger.mock(),
    });
    const entity = user('alice', 'a1');

    await expect(postProcess(processor, entity)).resolves.toBe(entity);
    await processor.stop();
  });

  it('does not record a new cycle for an unchanged processing etag', async () => {
    const store = new InMemoryHistoryStore();
    await recordExisting(store, user('alice', 'a1'));
    const processor = new HistoryRecordingCatalogProcessor({
      store,
      logger: mockServices.logger.mock(),
    });

    await postProcess(processor, user('alice', 'a1'));
    await processor.flush();

    expect(store.cycles).toHaveLength(1);
  });

  it('records a processing delta when the size trigger is reached', async () => {
    const store = new InMemoryHistoryStore();
    const processor = new HistoryRecordingCatalogProcessor({
      store,
      logger: mockServices.logger.mock(),
      maxBatchSize: 2,
    });

    await postProcess(processor, user('alice', 'a1'));
    await postProcess(processor, user('bob', 'b1'));
    await postProcess(processor, user('carol', 'c1'));

    expect(store.cycles).toHaveLength(1);
    expect(store.cycles[0]).toMatchObject({
      provider: 'processing',
      source: 'processing',
      mutationType: 'delta',
      deletes: [],
    });
    await processor.stop();
  });

  it('records a processing delta when the timer trigger elapses', async () => {
    jest.useFakeTimers({ doNotFake: [] });
    const store = new InMemoryHistoryStore();
    const processor = new HistoryRecordingCatalogProcessor({
      store,
      logger: mockServices.logger.mock(),
      flushIntervalMs: 1000,
    });

    await postProcess(processor, user('alice', 'a1'));
    expect(store.cycles).toHaveLength(0);

    await jest.advanceTimersByTimeAsync(1000);

    expect(store.cycles).toHaveLength(1);
  });

  it('classifies existing changed refs as updates and new refs as inserts', async () => {
    const store = new InMemoryHistoryStore();
    await recordExisting(store, user('alice', 'a1'));
    const processor = new HistoryRecordingCatalogProcessor({
      store,
      logger: mockServices.logger.mock(),
    });

    await postProcess(processor, user('alice', 'a2'));
    await postProcess(processor, user('bob', 'b1'));
    await processor.flush();

    const cycle = store.cycles[1];
    expect(cycle.updates.map(row => row.entityRef)).toEqual([
      'user:default/alice',
    ]);
    expect(cycle.inserts.map(row => row.entityRef)).toEqual([
      'user:default/bob',
    ]);
  });

  it('does not let provider-source history suppress processing capture', async () => {
    const store = new InMemoryHistoryStore();
    await recordExisting(store, user('zoe', 'z1'), 'provider');
    const processor = new HistoryRecordingCatalogProcessor({
      store,
      logger: mockServices.logger.mock(),
    });

    await postProcess(processor, user('zoe', 'z1'));
    await processor.flush();

    expect(store.cycles).toHaveLength(2);
    expect(store.cycles[1].inserts.map(row => row.entityRef)).toEqual([
      'user:default/zoe',
    ]);
  });

  it('returns the entity and logs an error when recordCycle rejects', async () => {
    const store = new InMemoryHistoryStore();
    jest.spyOn(store, 'recordCycle').mockRejectedValue(new Error('db down'));
    const logger = mockServices.logger.mock();
    const processor = new HistoryRecordingCatalogProcessor({
      store,
      logger,
      maxBatchSize: 1,
    });
    const entity = user('alice', 'a1');

    await expect(postProcess(processor, entity)).resolves.toBe(entity);

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringMatching(/Failed to flush processor-layer catalog history/),
      expect.any(Error),
    );
  });

  it('does not record anything when flush is called with nothing queued', async () => {
    const store = new InMemoryHistoryStore();
    const processor = new HistoryRecordingCatalogProcessor({
      store,
      logger: mockServices.logger.mock(),
    });

    await processor.flush();

    expect(store.cycles).toHaveLength(0);
  });

  it('flushes queued rows on stop', async () => {
    const store = new InMemoryHistoryStore();
    const processor = new HistoryRecordingCatalogProcessor({
      store,
      logger: mockServices.logger.mock(),
    });

    await postProcess(processor, user('alice', 'a1'));
    await processor.stop();

    expect(store.cycles).toHaveLength(1);
    expect(store.cycles[0].inserts.map(row => row.entityRef)).toEqual([
      'user:default/alice',
    ]);
  });

  it('drains rows queued while an earlier flush is still in flight', async () => {
    const store = new InMemoryHistoryStore();
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const original = store.recordCycle.bind(store);
    let firstCall = true;
    jest.spyOn(store, 'recordCycle').mockImplementation(async input => {
      if (firstCall) {
        firstCall = false;
        await gate;
      }
      return original(input);
    });
    const processor = new HistoryRecordingCatalogProcessor({
      store,
      logger: mockServices.logger.mock(),
      maxBatchSize: 10,
      flushIntervalMs: 60_000,
    });

    await postProcess(processor, user('alice', 'a1'));
    const inFlight = processor.flush(); // blocks on the gated recordCycle
    await postProcess(processor, user('bob', 'b1')); // queued mid-flush
    release();
    await inFlight; // the flush loop must also drain bob

    expect(store.cycles).toHaveLength(2);
    expect(store.cycles[0].inserts.map(row => row.entityRef)).toEqual([
      'user:default/alice',
    ]);
    expect(store.cycles[1].inserts.map(row => row.entityRef)).toEqual([
      'user:default/bob',
    ]);
  });

  it('makes stop wait for drain flushes started by another flush caller', async () => {
    const store = new InMemoryHistoryStore();
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    let secondStarted!: () => void;
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    const secondGate = new Promise<void>(resolve => {
      releaseSecond = resolve;
    });
    const secondStartedGate = new Promise<void>(resolve => {
      secondStarted = resolve;
    });
    const original = store.recordCycle.bind(store);
    let callCount = 0;
    jest.spyOn(store, 'recordCycle').mockImplementation(async input => {
      callCount += 1;
      if (callCount === 1) {
        await firstGate;
      } else if (callCount === 2) {
        secondStarted();
        await secondGate;
      }
      return original(input);
    });
    const processor = new HistoryRecordingCatalogProcessor({
      store,
      logger: mockServices.logger.mock(),
      maxBatchSize: 10,
      flushIntervalMs: 60_000,
    });

    await postProcess(processor, user('alice', 'a1'));
    const inFlight = processor.flush();
    let stopDone = false;
    const stopped = processor.stop().then(() => {
      stopDone = true;
    });
    await postProcess(processor, user('bob', 'b1'));

    releaseFirst();
    await secondStartedGate;
    await Promise.resolve();
    expect(stopDone).toBe(false);

    releaseSecond();
    await Promise.all([inFlight, stopped]);
    expect(store.cycles).toHaveLength(2);
    expect(store.cycles[1].inserts.map(row => row.entityRef)).toEqual([
      'user:default/bob',
    ]);
  });

  it('re-records an entity after a failed flush instead of treating it as unchanged', async () => {
    const store = new InMemoryHistoryStore();
    const original = store.recordCycle.bind(store);
    let failNext = true;
    jest.spyOn(store, 'recordCycle').mockImplementation(async input => {
      if (failNext) {
        failNext = false;
        throw new Error('db down');
      }
      return original(input);
    });
    const logger = mockServices.logger.mock();
    const processor = new HistoryRecordingCatalogProcessor({
      store,
      logger,
      maxBatchSize: 1,
    });
    const entity = user('alice', 'a1');

    // First observation: size-triggered flush fails; the etag cache must
    // not keep claiming a1 was persisted.
    await postProcess(processor, entity);
    expect(store.cycles).toHaveLength(0);
    expect(logger.error).toHaveBeenCalled();

    // Same content again: without the cache rollback this would hit the
    // unchanged fast path and the entity would stay missing from history.
    await postProcess(processor, entity);
    expect(store.cycles).toHaveLength(1);
    expect(store.cycles[0].inserts.map(row => row.entityRef)).toEqual([
      'user:default/alice',
    ]);
  });

  it('restores the prior etag on failed update flush so the retry stays an update', async () => {
    const store = new InMemoryHistoryStore();
    await recordExisting(store, user('alice', 'a1'));

    const original = store.recordCycle.bind(store);
    let failNext = true;
    jest.spyOn(store, 'recordCycle').mockImplementation(async input => {
      if (failNext) {
        failNext = false;
        throw new Error('db down');
      }
      return original(input);
    });
    const processor = new HistoryRecordingCatalogProcessor({
      store,
      logger: mockServices.logger.mock(),
      maxBatchSize: 1,
    });

    // a1 -> a2 is an update; the flush fails and must restore a1 in the
    // cache (not delete the entry, which would misclassify the retry as
    // an insert and inflate n_added). cycles[0] is the seed cycle.
    await postProcess(processor, user('alice', 'a2'));
    expect(store.cycles).toHaveLength(1);

    await postProcess(processor, user('alice', 'a2'));
    expect(store.cycles).toHaveLength(2);
    expect(store.cycles[1].inserts).toEqual([]);
    expect(store.cycles[1].updates.map(row => row.entityRef)).toEqual([
      'user:default/alice',
    ]);
  });

  it('restores the pre-batch etag after a failed flush with repeated refs', async () => {
    const store = new InMemoryHistoryStore();
    await recordExisting(store, user('alice', 'a1'));

    const original = store.recordCycle.bind(store);
    let failNext = true;
    jest.spyOn(store, 'recordCycle').mockImplementation(async input => {
      if (failNext) {
        failNext = false;
        throw new Error('db down');
      }
      return original(input);
    });
    const processor = new HistoryRecordingCatalogProcessor({
      store,
      logger: mockServices.logger.mock(),
      maxBatchSize: 10,
    });

    // a1 -> a2 -> a3 are queued in one batch. If rollback restores a2
    // instead of the pre-batch a1, observing a2 again would incorrectly hit
    // the unchanged fast path and never record the retry.
    await postProcess(processor, user('alice', 'a2'));
    await postProcess(processor, user('alice', 'a3'));
    await processor.flush();
    expect(store.cycles).toHaveLength(1);

    await postProcess(processor, user('alice', 'a2'));
    await processor.flush();
    expect(store.cycles).toHaveLength(2);
    expect(store.cycles[1].inserts).toEqual([]);
    expect(store.cycles[1].updates.map(row => row.etag)).toEqual(['a2']);
  });
});
