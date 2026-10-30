import { KnexTimeoutError, type Knex } from 'knex';
import type {
  CaptureSource,
  ProviderMutationStore,
} from '@kunickiaj/backstage-plugin-catalog-history-node';

class ProviderMutationContentionError extends Error {
  constructor(cause: unknown) {
    super('Provider mutation acquisition is still contended', { cause });
  }
}

async function lockProvider(tx: Knex.Transaction, provider: string) {
  try {
    await tx.raw(
      `SELECT pg_advisory_xact_lock(hashtextextended(
        json_build_array('catalog-history:provider-mutation',
          'catalog_history_provider_coordination'::regclass::oid,
          ?::text, 'provider')::text, 0))`,
      [provider],
    );
  } catch (error) {
    // Only this lock statement may turn PostgreSQL timeouts into retries.
    // Timestamp initialization, callback SQL, and commit errors must propagate.
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === '55P03' || error.code === '57014')
    ) {
      throw new ProviderMutationContentionError(error);
    }
    throw error;
  }
}

async function acquireProviderLock(tx: Knex.Transaction, provider: string) {
  // All settings are transaction-local. Never expire ownership while an
  // external catalog call can still complete, including on PostgreSQL 17+.
  await tx.raw("SET LOCAL idle_in_transaction_session_timeout = '0'");
  await tx.raw(`
    SELECT set_config(name, '0', true)
    FROM pg_catalog.pg_settings WHERE name = 'transaction_timeout'
  `);
  await tx.raw("SET LOCAL lock_timeout = '5s'");
  await tx.raw("SET LOCAL statement_timeout = '5s'");
  await lockProvider(tx, provider);
  await tx.raw("SET LOCAL statement_timeout = '30s'");
}

async function startProviderTimestamp(
  tx: Knex.Transaction,
  provider: string,
): Promise<Date> {
  const existing = await tx.raw<{ rows: Array<{ last_timestamp: Date }> }>(
    `UPDATE catalog_history_provider_coordination SET last_timestamp = greatest(
       date_trunc('milliseconds', clock_timestamp()) + interval '1 millisecond',
       last_timestamp + interval '1 millisecond'
     ) WHERE provider = ? AND source = 'provider' RETURNING last_timestamp`,
    [provider],
  );
  if (existing.rows.length > 0) return existing.rows[0].last_timestamp;
  // Round strictly above legacy microsecond timestamps before crossing the
  // JS Date boundary. UUID cycle cursors then never need to break a time tie.
  const result = await tx.raw<{ rows: Array<{ last_timestamp: Date }> }>(
    `INSERT INTO catalog_history_provider_coordination
       (provider, source, last_timestamp)
     SELECT ?, 'provider', date_trunc('milliseconds', greatest(
       clock_timestamp(),
       (SELECT max(greatest(started_at, finished_at))
        FROM catalog_history_cycles WHERE provider = ? AND source = 'provider'),
       (SELECT max(changed_at) FROM catalog_history_entities
        WHERE provider = ? AND source = 'provider')
     )) + interval '1 millisecond'
     ON CONFLICT (provider, source) DO UPDATE SET last_timestamp = greatest(
       EXCLUDED.last_timestamp,
       catalog_history_provider_coordination.last_timestamp + interval '1 millisecond'
     ) RETURNING last_timestamp`,
    [provider, provider, provider],
  );
  return result.rows[0].last_timestamp;
}

async function finishProviderTimestamp(
  tx: Knex.Transaction,
  provider: string,
): Promise<Date> {
  const result = await tx.raw<{ rows: Array<{ last_timestamp: Date }> }>(
    `UPDATE catalog_history_provider_coordination SET last_timestamp = greatest(
       date_trunc('milliseconds', clock_timestamp()) + interval '1 millisecond',
       last_timestamp + interval '1 millisecond'
     ) WHERE provider = ? AND source = 'provider' RETURNING last_timestamp`,
    [provider],
  );
  return result.rows[0].last_timestamp;
}

function assertScope(
  active: boolean,
  expected: string,
  provider: string,
  source: CaptureSource,
) {
  if (!active) throw new Error('Provider mutation store is no longer active');
  if (expected !== provider || source !== 'provider') {
    throw new Error(
      'Provider mutation store requires its provider and provider source',
    );
  }
}

function createScopedStore(options: {
  tx: Knex.Transaction;
  provider: string;
  startedAt: Date;
  store: ProviderMutationStore;
}) {
  const { tx, provider, startedAt, store } = options;
  let active = true;
  let attempted = false;
  let recorded = false;
  let pending = 0;
  const scoped: ProviderMutationStore = {
    async loadCurrentEtags(requested, opts = {}) {
      assertScope(active, provider, requested, opts.source ?? 'provider');
      pending++;
      try {
        return await store.loadCurrentEtags(provider, { source: 'provider' });
      } finally {
        pending--;
      }
    },
    async recordCycle(input) {
      assertScope(active, provider, input.provider, input.source);
      if (attempted)
        throw new Error('Provider mutation must record exactly one cycle');
      attempted = true;
      pending++;
      try {
        const finishedAt = await finishProviderTimestamp(tx, provider);
        await store.recordCycle({ ...input, startedAt, finishedAt });
        recorded = true;
      } finally {
        pending--;
      }
    },
  };
  return {
    store: scoped,
    close() {
      active = false;
    },
    assertRecorded() {
      if (!recorded || pending !== 0) {
        throw new Error(
          'Provider mutation must await exactly one recorded cycle and all reads',
        );
      }
    },
  };
}

type ProviderMutationOptions<T> = {
  db: Knex;
  provider: string;
  work: (store: ProviderMutationStore) => Promise<T>;
  createStore: (tx: Knex.Transaction) => ProviderMutationStore;
  assertOpen: () => void;
};

async function attemptProviderMutation<T>(
  options: ProviderMutationOptions<T>,
): Promise<T> {
  let entered = false;
  try {
    return await providerMutationTransaction(options, () => {
      entered = true;
    });
  } catch (error) {
    // A Knex timeout after entry may come from user work. Retrying it would
    // repeat catalog forwarding or an operation with an unknown commit result.
    if (!entered && error instanceof KnexTimeoutError) {
      throw new ProviderMutationContentionError(error);
    }
    throw error;
  }
}

async function providerMutationTransaction<T>(
  options: ProviderMutationOptions<T>,
  onEntry: () => void,
): Promise<T> {
  const { db, provider, work, createStore } = options;
  return db.transaction(
    async tx => {
      onEntry();
      await acquireProviderLock(tx, provider);
      options.assertOpen();
      const startedAt = await startProviderTimestamp(tx, provider);
      const scoped = createScopedStore({
        tx,
        provider,
        startedAt,
        store: createStore(tx),
      });
      try {
        const result = await work(scoped.store);
        scoped.assertRecorded();
        return result;
      } finally {
        scoped.close();
      }
    },
    { isolationLevel: 'read committed' },
  );
}

export async function runProviderMutation<T>(
  options: ProviderMutationOptions<T>,
): Promise<T> {
  // Each awaited attempt waits on a real pool/lock acquisition timeout. There
  // is no lease or overall deadline that could let a healthy writer overtake.
  for (;;) {
    options.assertOpen();
    try {
      return await attemptProviderMutation(options);
    } catch (error) {
      if (!(error instanceof ProviderMutationContentionError)) throw error;
    }
  }
}
