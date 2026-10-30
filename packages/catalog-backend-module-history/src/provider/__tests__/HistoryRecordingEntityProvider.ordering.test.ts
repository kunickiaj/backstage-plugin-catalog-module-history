import type { Entity } from '@backstage/catalog-model';
import { mockServices } from '@backstage/backend-test-utils';
import type {
  EntityProvider,
  EntityProviderConnection,
  EntityProviderMutation,
} from '@backstage/plugin-catalog-node';
import type {
  CaptureSource,
  CycleInput,
} from '@kunickiaj/backstage-plugin-catalog-history-node';
import { InMemoryHistoryStore } from '@kunickiaj/backstage-plugin-catalog-history-node/testUtils';
import { HistoryRecordingEntityProvider } from '../HistoryRecordingEntityProvider';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function user(etag: string): Entity {
  return {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'User',
    metadata: { name: 'alice', namespace: 'default', etag },
    spec: { profile: { displayName: etag } },
  };
}

function full(etag: string): EntityProviderMutation {
  return { type: 'full', entities: [{ entity: user(etag) }] };
}

function push(etag: string): EntityProviderMutation {
  return { type: 'delta', added: [{ entity: user(etag) }], removed: [] };
}

/** Exposes the wrapped connection so a test can issue overlapping calls. */
class CapturingProvider implements EntityProvider {
  connection!: EntityProviderConnection;
  constructor(private readonly name = 'directory') {}
  getProviderName() {
    return this.name;
  }
  async connect(connection: EntityProviderConnection) {
    this.connection = connection;
  }
}

/**
 * An in-memory store whose baseline reads and recordings can be held open
 * one call at a time, to force a specific interleaving.
 */
class GatedStore extends InMemoryHistoryStore {
  readonly loadGates: Array<Promise<void>> = [];
  readonly recordGates: Array<Promise<void>> = [];
  readonly events: string[] = [];
  readonly baselineStarted = deferred();
  readonly recordingStarted = deferred();
  private loads = 0;
  private records = 0;

  async loadCurrentEtags(provider: string, opts?: { source?: CaptureSource }) {
    const call = this.loads++;
    this.events.push(`load:${call}`);
    this.baselineStarted.resolve();
    await this.loadGates[call];
    return super.loadCurrentEtags(provider, opts);
  }

  async recordCycle(input: CycleInput) {
    const call = this.records++;
    this.events.push(`record:${call}`);
    this.recordingStarted.resolve();
    await this.recordGates[call];
    return super.recordCycle(input);
  }

  latestEtag(provider = 'directory') {
    return this.loadCurrentEtags(provider).then(map =>
      map.get('user:default/alice'),
    );
  }
}

function catalog() {
  const applied: string[] = [];
  const connection: EntityProviderConnection = {
    applyMutation: jest.fn(async mutation => {
      const entries =
        mutation.type === 'full' ? mutation.entities : mutation.added;
      applied.push(`${mutation.type}:${entries[0]?.entity.metadata.etag}`);
    }),
    refresh: jest.fn(),
  };
  return { connection, applied };
}

async function setup(
  options: {
    convertFullToDelta?: boolean;
    store?: GatedStore;
    provider?: string;
    catalog?: ReturnType<typeof catalog>;
  } = {},
) {
  const store = options.store ?? new GatedStore();
  const logger = mockServices.logger.mock();
  const inner = new CapturingProvider(options.provider);
  const wrapper = new HistoryRecordingEntityProvider({
    inner,
    store,
    logger,
    convertFullToDelta: options.convertFullToDelta,
  });
  const { connection, applied } = options.catalog ?? catalog();
  await wrapper.connect(connection);
  return {
    store,
    logger,
    connection,
    applied,
    apply: inner.connection.applyMutation,
  };
}

describe('HistoryRecordingEntityProvider ordering', () => {
  it('serializes two wrappers for the same provider while the first baseline is blocked', async () => {
    // Arrange: the catalog accepted the old full before its baseline blocks.
    const store = new GatedStore();
    const slowBaseline = deferred();
    store.loadGates[0] = slowBaseline.promise;
    const sharedCatalog = catalog();
    const firstWrapper = await setup({ store, catalog: sharedCatalog });
    const secondWrapper = await setup({ store, catalog: sharedCatalog });

    // Act: a second wrapper receives a push while the old full still records.
    const first = firstWrapper.apply(full('old'));
    await store.baselineStarted.promise;
    const second = secondWrapper.apply(push('new'));
    await new Promise(resolve => setImmediate(resolve));
    const forwardedWhileBlocked = [...sharedCatalog.applied];
    slowBaseline.resolve();
    await Promise.all([first, second]);

    // Assert: catalog and history agree on the last accepted entity.
    expect(forwardedWhileBlocked).toEqual(['full:old']);
    expect(sharedCatalog.applied).toEqual(['full:old', 'delta:new']);
    expect(store.cycles.map(cycle => cycle.mutationType)).toEqual([
      'full',
      'delta',
    ]);
    expect(store.cycles[0].inserts[0].etag).toBe('old');
    expect(store.cycles[1].updates[0].etag).toBe('new');
    expect(await store.latestEtag()).toBe('new');
  });

  it('records an overlapping full and push in arrival order', async () => {
    // Arrange: the full's baseline read is slow, so without ordering the
    // push records first and the stale full lands on top of it.
    const store = new GatedStore();
    const slowBaseline = deferred();
    store.loadGates[0] = slowBaseline.promise;
    const { apply, applied } = await setup({ store });
    // Act
    const first = apply(full('old'));
    const second = apply(push('new'));
    await new Promise(resolve => setImmediate(resolve));
    slowBaseline.resolve();
    await Promise.all([first, second]);
    // Assert
    expect(applied).toEqual(['full:old', 'delta:new']);
    expect(store.cycles.map(cycle => cycle.mutationType)).toEqual([
      'full',
      'delta',
    ]);
    expect(await store.latestEtag()).toBe('new');
  });

  it('records an overlapping push and full in arrival order', async () => {
    // Arrange: the push's recording is slow.
    const store = new GatedStore();
    const slowRecord = deferred();
    store.recordGates[0] = slowRecord.promise;
    const { apply, applied } = await setup({ store });
    // Act
    const first = apply(push('old'));
    const second = apply(full('new'));
    await new Promise(resolve => setImmediate(resolve));
    slowRecord.resolve();
    await Promise.all([first, second]);
    // Assert
    expect(applied).toEqual(['delta:old', 'full:new']);
    expect(store.cycles.map(cycle => cycle.mutationType)).toEqual([
      'delta',
      'full',
    ]);
    // The full read its baseline after the push recorded, so it is an update.
    expect(store.cycles[1].updates).toHaveLength(1);
    expect(await store.latestEtag()).toBe('new');
  });

  it('holds later catalog writes until slow history finishes', async () => {
    // Arrange
    const store = new GatedStore();
    const slowRecord = deferred();
    store.recordGates[0] = slowRecord.promise;
    const { apply, applied } = await setup({ store });
    // Act
    const first = apply(full('one'));
    const second = apply(push('two'));
    const third = apply(push('three'));
    await store.recordingStarted.promise;
    // Assert: the exclusion covers the first call's recording.
    expect(applied).toEqual(['full:one']);
    expect(store.cycles).toHaveLength(0);
    slowRecord.resolve();
    await Promise.all([first, second, third]);
    expect(applied).toEqual(['full:one', 'delta:two', 'delta:three']);
    expect(store.cycles).toHaveLength(3);
    expect(await store.latestEtag()).toBe('three');
  });

  it('resolves each call only after its own recording', async () => {
    // Arrange
    const store = new GatedStore();
    const slowRecord = deferred();
    store.recordGates[0] = slowRecord.promise;
    const { apply } = await setup({ store });
    let settled = false;
    // Act
    const call = apply(full('one')).then(() => {
      settled = true;
    });
    await new Promise(resolve => setImmediate(resolve));
    // Assert: the caller feels slow history as backpressure.
    expect(settled).toBe(false);
    slowRecord.resolve();
    await call;
    expect(settled).toBe(true);
  });

  it('keeps going after a failed recording and a failed forward', async () => {
    // Arrange
    const store = new GatedStore();
    const failedRecord = deferred();
    store.recordGates[0] = failedRecord.promise;
    const { apply, connection, logger } = await setup({ store });
    (connection.applyMutation as jest.Mock).mockImplementation(
      async (mutation: EntityProviderMutation) => {
        if (
          mutation.type === 'delta' &&
          mutation.added[0]?.entity.metadata.etag === 'boom'
        ) {
          throw new Error('catalog unavailable');
        }
      },
    );
    // Act
    const first = apply(full('one'));
    const second = apply(push('boom'));
    const third = apply(push('three'));
    failedRecord.reject(new Error('history unavailable'));
    // Assert
    await expect(first).resolves.toBeUndefined();
    await expect(second).rejects.toThrow('catalog unavailable');
    await expect(third).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to record history cycle for provider directory',
      expect.any(Error),
    );
    // Only the last mutation reached history; the failed forward recorded nothing.
    expect(store.cycles.map(cycle => cycle.inserts[0]?.etag)).toEqual([
      'three',
    ]);
    expect(await store.latestEtag()).toBe('three');
  });

  it('warns once when more than 20 provider mutations are queued', async () => {
    // Arrange
    const store = new GatedStore();
    const slowRecord = deferred();
    store.recordGates[0] = slowRecord.promise;
    const { apply, logger } = await setup({ store });
    // Act
    const calls = Array.from({ length: 25 }, (_, i) => apply(push(`e${i}`)));
    await new Promise(resolve => setImmediate(resolve));
    // Assert
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/provider directory.*21/),
    );
    expect(logger.warn.mock.calls[0][0]).toMatch(/catalog.*wait/i);
    slowRecord.resolve();
    await Promise.all(calls);
    expect(await store.latestEtag()).toBe('e24');
  });

  it('does not repeat the warning while the backlog hovers above the threshold', async () => {
    // Arrange
    const store = new GatedStore();
    const slowRecord = deferred();
    store.recordGates[0] = slowRecord.promise;
    const { apply, logger } = await setup({ store });
    const calls = Array.from({ length: 22 }, (_, i) => apply(push(`e${i}`)));
    await new Promise(resolve => setImmediate(resolve));
    // Act: release the stuck item, let a few drain, then add more.
    slowRecord.resolve();
    await calls[3];
    const more = Array.from({ length: 5 }, (_, i) => apply(push(`f${i}`)));
    await Promise.all([...calls, ...more]);
    // Assert
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('keeps forwarding and recording after a conversion throws', async () => {
    // Arrange: a baseline exists, so the next full goes through conversion.
    const { apply, applied, store } = await setup({ convertFullToDelta: true });
    await apply(full('old'));
    const broken = {
      type: 'full',
      entities: [{ entity: { apiVersion: 'v1', kind: 'User' } as Entity }],
    } as EntityProviderMutation;
    // Act
    const failing = apply(broken);
    const later = apply(push('new'));
    // Assert
    await expect(failing).rejects.toThrow();
    await expect(later).resolves.toBeUndefined();
    expect(applied).toEqual(['full:old', 'delta:new']);
    expect(await store.latestEtag()).toBe('new');
  });

  it('keeps arrival order across default and converted mutations', async () => {
    // Arrange: a baseline exists, and the converted full's baseline read is slow.
    const store = new GatedStore();
    const { apply, applied } = await setup({ store, convertFullToDelta: true });
    await apply(full('base'));
    const slowBaseline = deferred();
    store.loadGates[store.events.filter(e => e.startsWith('load')).length + 1] =
      slowBaseline.promise;
    // Act
    const first = apply(push('one'));
    const second = apply(full('two'));
    const third = apply(push('three'));
    await new Promise(resolve => setImmediate(resolve));
    // Assert: the later push waits for the converted full's forward.
    expect(applied).toEqual(['full:base', 'delta:one']);
    slowBaseline.resolve();
    await Promise.all([first, second, third]);
    expect(applied).toEqual([
      'full:base',
      'delta:one',
      'delta:two',
      'delta:three',
    ]);
    expect(store.cycles.map(cycle => cycle.mutationType)).toEqual([
      'full',
      'delta',
      'full',
      'delta',
    ]);
    expect(await store.latestEtag()).toBe('three');
  });

  it('keeps different providers independent on the same store', async () => {
    // Arrange: one provider's history is stuck.
    const stuck = new GatedStore();
    const release = deferred();
    stuck.recordGates[0] = release.promise;
    const a = await setup({ store: stuck, provider: 'a' });
    const b = await setup({ store: stuck, provider: 'b' });
    // Act
    const first = a.apply(full('a'));
    await stuck.recordingStarted.promise;
    await b.apply(full('b'));
    // Assert
    expect(b.store.cycles).toHaveLength(1);
    expect(b.store.cycles[0].provider).toBe('b');
    expect(a.applied).toEqual(['full:a']);
    expect(b.applied).toEqual(['full:b']);
    release.resolve();
    await first;
  });

  it('reads each conversion baseline after earlier mutations recorded', async () => {
    // Arrange: overlapping fulls with conversion on.
    const store = new GatedStore();
    const slowRecord = deferred();
    store.recordGates[0] = slowRecord.promise;
    const { apply, applied } = await setup({ store, convertFullToDelta: true });
    // Act
    const first = apply(full('old'));
    const second = apply(full('new'));
    await new Promise(resolve => setImmediate(resolve));
    // Assert: the second full waits for the first to record before reading.
    expect(store.events).toEqual(['load:0', 'record:0']);
    slowRecord.resolve();
    await Promise.all([first, second]);
    expect(store.events).toEqual(['load:0', 'record:0', 'load:1', 'record:1']);
    expect(applied).toHaveLength(2);
    expect(store.cycles[1].updates).toHaveLength(1);
    expect(await store.latestEtag()).toBe('new');
  });
});
