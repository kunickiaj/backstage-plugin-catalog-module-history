import type { HistoryStore } from '@kunickiaj/backstage-plugin-catalog-history-node';

/** Every query method that capability checks and the history router probe. */
export type LazyHistoryQuery = Required<NonNullable<HistoryStore['query']>>;

/** A store whose query object implements every optional read. */
export type LoadedHistoryStore = HistoryStore &
  Required<Pick<HistoryStore, 'planRetention' | 'applyRetention'>> & {
    readonly query: LazyHistoryQuery;
  };

export type LazyHistoryStore = LoadedHistoryStore & {
  ensureReady(): Promise<void>;
  addShutdownHook(hook: () => Promise<void>): void;
  shutdown(): Promise<void>;
};

/**
 * Wraps a store so that its database resources are acquired on first use.
 *
 * Resolving the service is free: disabled history, or a backend that never
 * touches history, acquires no client and runs no migrations. Concurrent first
 * calls share one load. A failed load is not cached, so the next call retries.
 *
 * Shutdown runs registered hooks first, so buffered capture can still flush.
 * It then releases the inner store only when one was created, even when a
 * hook fails. After hooks
 * finish, shutdown refuses to start a new load, which would otherwise open a
 * pool that nothing releases.
 */
export function createLazyHistoryStore(
  load: () => Promise<LoadedHistoryStore>,
): LazyHistoryStore {
  let pending: Promise<LoadedHistoryStore> | undefined;
  let closed = false;
  let shutdownPromise: Promise<void> | undefined;
  const hooks: Array<() => Promise<void>> = [];

  const resolve = (): Promise<LoadedHistoryStore> => {
    if (pending) return pending;
    if (closed) {
      return Promise.reject(
        new Error('catalog history store has already shut down'),
      );
    }
    pending = load().catch(error => {
      pending = undefined;
      throw error;
    });
    return pending;
  };

  const shutdownOnce = async (): Promise<void> => {
    try {
      for (const hook of hooks) {
        await hook();
      }
    } finally {
      // A failed flush must not leak the pool or the metrics registrations.
      closed = true;
      const loaded = await pending?.catch(() => undefined);
      await loaded?.shutdown?.();
    }
  };

  const query: LazyHistoryQuery = {
    getEntityTimeline: async request =>
      (await resolve()).query.getEntityTimeline(request),
    getEntityVersions: async request =>
      (await resolve()).query.getEntityVersions(request),
    getEntityVersion: async request =>
      (await resolve()).query.getEntityVersion(request),
    getEntityAsOf: async request =>
      (await resolve()).query.getEntityAsOf(request),
    getEntityDiff: async request =>
      (await resolve()).query.getEntityDiff(request),
    getChangeFeed: async request =>
      (await resolve()).query.getChangeFeed(request),
    getProviders: async request =>
      (await resolve()).query.getProviders(request),
    getEntities: async request => (await resolve()).query.getEntities(request),
    getKinds: async request => (await resolve()).query.getKinds(request),
    listCycles: async request => (await resolve()).query.listCycles(request),
    getCycle: async request => (await resolve()).query.getCycle(request),
  };

  return {
    query,
    async ensureReady() {
      const store = await resolve();
      await store.ensureReady?.();
    },
    addShutdownHook(hook) {
      // Matches PostgresHistoryStore: the most recently added hook runs first.
      hooks.unshift(hook);
    },
    async shutdown() {
      shutdownPromise ??= shutdownOnce();
      await shutdownPromise;
    },
    async loadCurrentEtags(provider, opts) {
      return (await resolve()).loadCurrentEtags(provider, opts);
    },
    async loadAllCurrentEtags(opts) {
      return (await resolve()).loadAllCurrentEtags(opts);
    },
    async recordCycle(input) {
      return (await resolve()).recordCycle(input);
    },
    async planRetention(request) {
      return (await resolve()).planRetention(request);
    },
    async applyRetention(request) {
      return (await resolve()).applyRetention(request);
    },
  };
}
