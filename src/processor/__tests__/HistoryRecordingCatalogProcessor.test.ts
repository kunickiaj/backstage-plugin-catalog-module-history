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

  it('returns the entity and warns when recordCycle rejects', async () => {
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

    expect(logger.warn).toHaveBeenCalledWith(
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
});
