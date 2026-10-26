import { createServiceFactory } from '@backstage/backend-plugin-api';
import {
  catalogProcessingExtensionPoint,
  catalogServiceRef,
  type CatalogService,
} from '@backstage/plugin-catalog-node';
import {
  mockServices,
  startTestBackend,
  type TestBackend,
} from '@backstage/backend-test-utils';
import type { JsonObject } from '@backstage/types';
import {
  HistoryRetentionAbortedError,
  historyStoreServiceRef,
  type HistoryRetentionCounts,
  type HistoryStore,
} from '@kunickiaj/backstage-plugin-catalog-history-node';
import { catalogModuleHistory } from '../catalogModuleHistory';

jest.setTimeout(30000);

const DAY_MS = 24 * 60 * 60 * 1000;
const COUNTS: HistoryRetentionCounts = {
  deletedEntityRows: 3,
  supersededRows: 5,
  emptyCycles: 7,
};

type FakeStore = HistoryStore & {
  ensureReady: jest.Mock;
  planRetention: jest.Mock;
  applyRetention: jest.Mock;
};

function fakeStore(): FakeStore {
  return {
    ensureReady: jest.fn(async () => undefined),
    loadCurrentEtags: jest.fn(async () => new Map()),
    loadAllCurrentEtags: jest.fn(async () => new Map()),
    recordCycle: jest.fn(async () => undefined),
    planRetention: jest.fn(async () => COUNTS),
    applyRetention: jest.fn(async () => COUNTS),
  };
}

describe('catalogModuleHistory retention', () => {
  let backend: TestBackend | undefined;

  const catalogServiceFactory = createServiceFactory({
    service: catalogServiceRef,
    deps: {},
    factory: () => ({}) as CatalogService,
  });

  function storeFactory(store: HistoryStore) {
    return createServiceFactory({
      service: historyStoreServiceRef,
      deps: {},
      factory: () => store,
    });
  }

  async function start(options: {
    store: HistoryStore;
    retention?: JsonObject;
    history?: JsonObject;
  }) {
    const logger = mockServices.logger.mock();
    const scheduler = mockServices.scheduler.mock();
    backend = await startTestBackend({
      extensionPoints: [
        [catalogProcessingExtensionPoint, { addProcessor: jest.fn() }],
      ],
      features: [
        catalogModuleHistory,
        catalogServiceFactory,
        storeFactory(options.store),
        logger.factory,
        scheduler.factory,
        mockServices.rootConfig.factory({
          data: {
            catalog: {
              history: {
                ...options.history,
                ...(options.retention ? { retention: options.retention } : {}),
              },
            },
          },
        }),
      ],
    });
    return { logger, scheduler };
  }

  function retentionTask(
    scheduler: ReturnType<typeof mockServices.scheduler.mock>,
  ) {
    const call = scheduler.scheduleTask.mock.calls.find(
      ([task]) => task.id === 'catalog-history-retention',
    );
    if (!call) {
      throw new Error('retention task was not scheduled');
    }
    return call[0];
  }

  afterEach(async () => {
    await backend?.stop();
    backend = undefined;
  });

  it('schedules nothing and calls no retention methods by default', async () => {
    const store = fakeStore();

    const { scheduler, logger } = await start({ store });

    expect(scheduler.scheduleTask).not.toHaveBeenCalled();
    expect(store.planRetention).not.toHaveBeenCalled();
    expect(store.applyRetention).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('retention=off'),
    );
  });

  it('schedules nothing when catalog.history.enabled is false', async () => {
    const store = fakeStore();

    const { scheduler } = await start({
      store,
      history: { enabled: false },
      retention: { enabled: true, maxAge: { days: 30 } },
    });

    expect(scheduler.scheduleTask).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'missing maxAge',
      retention: { enabled: true },
      message: /catalog\.history\.retention\.maxAge is required/,
    },
    {
      name: 'maxAge under 1 day',
      retention: { enabled: true, maxAge: { hours: 23 } },
      message: /catalog\.history\.retention\.maxAge must be at least 1 day/,
    },
    {
      name: 'unparseable maxAge',
      retention: { enabled: true, maxAge: 'P1X' },
      message: /Invalid catalog\.history\.retention\.maxAge/,
    },
    {
      name: 'zero batchSize',
      retention: { enabled: true, maxAge: { days: 30 }, batchSize: 0 },
      message: /catalog\.history\.retention\.batchSize must be an integer/,
    },
    {
      name: 'fractional batchSize',
      retention: { enabled: true, maxAge: { days: 30 }, batchSize: 1.5 },
      message: /catalog\.history\.retention\.batchSize must be an integer/,
    },
    {
      name: 'batchSize over 10000',
      retention: { enabled: true, maxAge: { days: 30 }, batchSize: 10001 },
      message: /catalog\.history\.retention\.batchSize must be an integer/,
    },
    {
      name: 'non-numeric batchSize',
      retention: { enabled: true, maxAge: { days: 30 }, batchSize: 'many' },
      message: /catalog\.history\.retention\.batchSize must be an integer/,
    },
  ])('fails startup for $name', async ({ retention, message }) => {
    await expect(start({ store: fakeStore(), retention })).rejects.toThrow(
      message,
    );
  });

  it.each(['planRetention', 'applyRetention'] as const)(
    'fails startup when the store lacks %s',
    async method => {
      const store: HistoryStore = { ...fakeStore(), [method]: undefined };

      await expect(
        start({ store, retention: { enabled: true, maxAge: { days: 30 } } }),
      ).rejects.toThrow(
        /requires historyStoreServiceRef to provide planRetention and applyRetention/,
      );
    },
  );

  it('schedules the retention task with default schedule and logs dry-run mode', async () => {
    const { scheduler, logger } = await start({
      store: fakeStore(),
      retention: { enabled: true, maxAge: 'P30D' },
    });

    expect(scheduler.scheduleTask).toHaveBeenCalledTimes(1);
    const { fn: _fn, ...definition } = retentionTask(scheduler);
    expect(definition).toEqual({
      id: 'catalog-history-retention',
      frequency: { hours: 24 },
      timeout: { hours: 1 },
      initialDelay: { minutes: 5 },
    });
    // Unset scope means Backstage's default global scope: one replica runs it.
    expect(definition.scope ?? 'global').toBe('global');
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('retention=dry-run'),
    );
  });

  it('merges a partial retention schedule over the defaults', async () => {
    const { scheduler } = await start({
      store: fakeStore(),
      retention: {
        enabled: true,
        maxAge: { days: 30 },
        schedule: { frequency: { hours: 6 } },
      },
    });

    const { fn: _fn, ...definition } = retentionTask(scheduler);
    expect(definition).toEqual({
      id: 'catalog-history-retention',
      frequency: { hours: 6 },
      timeout: { hours: 1 },
      initialDelay: { minutes: 5 },
    });
  });

  it('keeps the reconciler schedule defaults when both tasks are enabled', async () => {
    const { scheduler } = await start({
      store: fakeStore(),
      history: { reconciler: { enabled: true } },
      retention: { enabled: true, maxAge: { days: 30 } },
    });

    expect(scheduler.scheduleTask).toHaveBeenCalledTimes(2);
    expect(scheduler.scheduleTask).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'catalog-history-reconcile',
        frequency: { hours: 1 },
        timeout: { minutes: 10 },
        initialDelay: { seconds: 30 },
      }),
    );
  });

  it('counts only in dry run with a cutoff of now minus maxAge', async () => {
    const store = fakeStore();
    const { scheduler, logger } = await start({
      store,
      retention: { enabled: true, maxAge: { days: 30 } },
    });

    const before = Date.now();
    await retentionTask(scheduler).fn(new AbortController().signal);
    const after = Date.now();

    expect(store.applyRetention).not.toHaveBeenCalled();
    expect(store.planRetention).toHaveBeenCalledTimes(1);
    const { cutoff } = store.planRetention.mock.calls[0][0];
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - 30 * DAY_MS);
    expect(cutoff.getTime()).toBeLessThanOrEqual(after - 30 * DAY_MS);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining(`mode=dry-run cutoff=${cutoff.toISOString()}`),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining(
        'deletedEntityRows=3 supersededRows=5 emptyCycles=7',
      ),
      expect.objectContaining({ mode: 'dry-run', ...COUNTS }),
    );
  });

  it('deletes with batchSize and the task signal when dryRun is false', async () => {
    const store = fakeStore();
    const { scheduler, logger } = await start({
      store,
      retention: {
        enabled: true,
        maxAge: { days: 30 },
        dryRun: false,
        batchSize: 250,
      },
    });
    const controller = new AbortController();

    await retentionTask(scheduler).fn(controller.signal);

    expect(store.planRetention).not.toHaveBeenCalled();
    expect(store.applyRetention).toHaveBeenCalledWith({
      cutoff: expect.any(Date),
      batchSize: 250,
      signal: controller.signal,
    });
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('retention=delete'),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('mode=delete'),
      expect.objectContaining(COUNTS),
    );
  });

  it('uses the default batch size of 1000', async () => {
    const store = fakeStore();
    const { scheduler } = await start({
      store,
      retention: { enabled: true, maxAge: { days: 30 }, dryRun: false },
    });

    await retentionTask(scheduler).fn(new AbortController().signal);

    expect(store.applyRetention).toHaveBeenCalledWith(
      expect.objectContaining({ batchSize: 1000 }),
    );
  });

  it('logs store errors without rethrowing', async () => {
    const store = fakeStore();
    const failure = new Error('database unavailable');
    store.applyRetention.mockRejectedValue(failure);
    const { scheduler, logger } = await start({
      store,
      retention: { enabled: true, maxAge: { days: 30 }, dryRun: false },
    });

    await expect(
      retentionTask(scheduler).fn(new AbortController().signal),
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      'catalog-history scheduled retention failed',
      failure,
    );
  });
  it('logs partial counts at warn when the task timeout stops a run', async () => {
    const store = fakeStore();
    store.applyRetention.mockRejectedValue(
      new HistoryRetentionAbortedError({ ...COUNTS, emptyCycles: 0 }),
    );
    const { scheduler, logger } = await start({
      store,
      retention: { enabled: true, maxAge: { days: 30 }, dryRun: false },
    });

    await expect(
      retentionTask(scheduler).fn(new AbortController().signal),
    ).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('stopped before finishing'),
      expect.objectContaining({ ...COUNTS, emptyCycles: 0 }),
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('rejects an invalid retention schedule before preparing the store', async () => {
    const store = fakeStore();
    await expect(
      start({
        store,
        retention: {
          enabled: true,
          maxAge: { days: 30 },
          schedule: { frequency: 'not a duration' },
        },
      }),
    ).rejects.toThrow(/retention\.schedule|frequency/i);
    expect(store.ensureReady).not.toHaveBeenCalled();
  });
});
