import { request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createServiceFactory } from '@backstage/backend-plugin-api';
import {
  mockCredentials,
  mockServices,
  startTestBackend,
  TestDatabases,
  type TestBackend,
} from '@backstage/backend-test-utils';
import {
  catalogProcessingExtensionPoint,
  catalogServiceRef,
  type CatalogService,
} from '@backstage/plugin-catalog-node';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import { historyStoreServiceFactory } from '@kunickiaj/backstage-plugin-catalog-history-storage-node';
import { knex, type Knex } from 'knex';
import request from 'supertest';
import { catalogModuleHistory } from '../catalogModuleHistory';

jest.setTimeout(30000);

const path = '/api/catalog/history/entities/User/default/alice/versions';
const provider = 'timeout-fixture';
const secret = 'timeout-fixture-private-snapshot';
const catalogServiceFactory = createServiceFactory({
  service: catalogServiceRef,
  deps: {},
  factory: () => ({ queryEntities: jest.fn() }) as unknown as CatalogService,
});

// Poll actual server state, not an assumed delay before aborting the client.
async function waitFor(predicate: () => Promise<boolean>, description: string) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Did not observe ${description}`);
}

describe('catalog history HTTP query deadlines', () => {
  const databases = TestDatabases.create({ ids: ['POSTGRES_16'] });
  let fixture: Knex;
  let db: Knex;
  let backend: TestBackend | undefined;
  let pid: number;
  let logger: ReturnType<typeof mockServices.logger.mock>;
  let failures: Array<{ code?: string; sql: string; bindings?: unknown[] }>;

  beforeEach(async () => {
    fixture = await databases.init('POSTGRES_16');
    db = knex({ ...fixture.client.config, pool: { min: 0, max: 1 } });
    logger = mockServices.logger.mock();
    const permissions = mockServices.permissions.mock();
    permissions.authorize.mockResolvedValue([
      { result: AuthorizeResult.ALLOW },
    ]);
    backend = await startTestBackend({
      extensionPoints: [
        [catalogProcessingExtensionPoint, { addProcessor: jest.fn() }],
      ],
      features: [
        catalogModuleHistory,
        catalogServiceFactory,
        historyStoreServiceFactory,
        mockServices.database.factory({ knex: db }),
        permissions.factory,
        logger.factory,
        mockServices.httpAuth.factory({
          defaultCredentials: mockCredentials.none(),
        }),
        mockServices.rootConfig.factory({
          data: {
            permission: { enabled: true },
            catalog: {
              history: { api: { enabled: true, queryTimeoutMs: 1500 } },
            },
          },
        }),
      ],
    });
    const cycleId = randomUUID();
    await db('catalog_history_cycles').insert({
      cycle_id: cycleId,
      provider,
      source: 'provider',
      mutation_type: 'full',
      started_at: '2026-01-01T00:00:00Z',
      finished_at: '2026-01-01T00:00:00Z',
    });
    await db('catalog_history_entities').insert({
      cycle_id: cycleId,
      entity_ref: 'user:default/alice',
      kind: 'User',
      namespace: 'default',
      name: 'alice',
      provider,
      source: 'provider',
      op: 'insert',
      etag: 'one',
      metadata: { description: secret },
      spec: {},
      changed_at: '2026-01-01T00:00:00Z',
    });
    // Complete the query service's lazy schema preparation before any lock.
    await request(backend.server)
      .get(path)
      .set('Authorization', mockCredentials.user.header())
      .expect(200);
    pid = (await db.raw('select pg_backend_pid() as pid')).rows[0].pid;
    failures = [];
    db.on(
      'query-error',
      (
        error: { code?: string },
        query: { sql: string; bindings?: unknown[] },
      ) => {
        if (query.sql.includes('catalog_history_entities')) {
          failures.push({
            code: error.code,
            sql: query.sql,
            bindings: query.bindings,
          });
        }
      },
    );
  });

  afterEach(async () => {
    await backend?.stop();
    backend = undefined;
    await db.destroy();
  });

  async function lockHistory() {
    const blocker = await fixture.transaction();
    await blocker.raw(
      'lock table catalog_history_entities in access exclusive mode',
    );
    let watchdogReleased = false;
    let release: Promise<void> | undefined;
    const watchdog = setTimeout(() => {
      watchdogReleased = true;
      release = Promise.resolve(blocker.rollback()).then(() => undefined);
    }, 10000);
    return {
      wasReleasedByWatchdog: () => watchdogReleased,
      async cleanup() {
        clearTimeout(watchdog);
        await (release ?? blocker.rollback());
        await blocker.executionPromise;
      },
    };
  }

  async function assertReadConnectionIdle() {
    const activity = await fixture('pg_stat_activity').where({ pid }).first();
    expect(activity.state).toBe('idle');
    expect(await fixture('pg_locks').where({ pid, granted: false })).toEqual(
      [],
    );
    expect(db.client.pool.numPendingAcquires()).toBe(0);
  }

  async function assertReusable() {
    await assertReadConnectionIdle();
    expect((await db.raw('select pg_backend_pid() as pid')).rows[0].pid).toBe(
      pid,
    );
    const response = await request(backend!.server)
      .get(path)
      .set('Authorization', mockCredentials.user.header());
    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0].snapshot.metadata.description).toBe(secret);
  }

  it('terminates a server SELECT at its deadline after the client disconnects while blocked', async () => {
    // Arrange: the only read connection must wait for this fixture's table lock.
    const blocker = await lockHistory();
    const address = backend!.server.address() as AddressInfo;
    const client = httpRequest({
      hostname: '127.0.0.1',
      port: address.port,
      path: `${path}?provider=${provider}`,
      headers: { Authorization: mockCredentials.user.header() },
      agent: false,
    });
    let clientError: Error | undefined;
    const clientClosed = new Promise<void>(resolve => {
      client.on('error', error => {
        clientError = error;
      });
      client.on('response', response => response.resume());
      client.on('close', resolve);
    });
    client.end();
    try {
      await waitFor(async () => {
        const activity = await fixture('pg_stat_activity')
          .where({ pid })
          .first();
        return (
          activity?.state === 'active' &&
          activity.wait_event_type === 'Lock' &&
          activity.query.includes('catalog_history_entities')
        );
      }, 'the HTTP history SELECT waiting for the relation lock');

      // Act: disconnect only after PostgreSQL confirms execution has started.
      client.destroy(new Error('fixture client disconnected'));
      await clientClosed;
      await waitFor(
        async () =>
          failures.length === 1 && logger.error.mock.calls.length === 1,
        'server cancellation and router error handling after disconnect',
      );

      // Assert: the server deadline, not lock release, ended the abandoned read.
      expect(clientError?.message).toBe('fixture client disconnected');
      expect(blocker.wasReleasedByWatchdog()).toBe(false);
      expect(failures[0]).toMatchObject({ code: '57014' });
      expect(failures[0].bindings).toContain(provider);
      expect(logger.error).toHaveBeenCalledWith(
        'Catalog history query failed',
        expect.objectContaining({ errorCode: '57014' }),
      );
      await assertReadConnectionIdle();
    } finally {
      client.destroy();
      await clientClosed;
      await blocker.cleanup();
      // Drain any read still running if an earlier assertion failed.
      await db.raw('select 1');
    }
    await assertReusable();
  });

  it('returns a sanitized HTTP 500 on server timeout and serves a later request', async () => {
    // Arrange: use the real default store and a real blocked PostgreSQL SELECT.
    const blocker = await lockHistory();
    try {
      // Act
      const response = await request(backend!.server)
        .get(path)
        .query({ provider })
        .set('Authorization', mockCredentials.user.header());
      // Assert: do not serialize Knex's SQL, bindings, or PostgreSQL error text.
      expect(blocker.wasReleasedByWatchdog()).toBe(false);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({ code: '57014' });
      expect(failures[0].bindings).toContain(provider);
      expect(response.status).toBe(500);
      expect(response.body.error?.message).toBe(
        'Unable to retrieve catalog history',
      );
      expect(response.body.error?.stack).toBeUndefined();
      expect(response.text).not.toMatch(
        /catalog_history_entities|select|57014|statement_timeout|statement timeout|bindings|parameters/i,
      );
      expect(response.text).not.toContain(secret);
      // Backstage echoes the request URL separately; database bindings must
      // never appear in the serialized error itself.
      expect(JSON.stringify(response.body.error)).not.toContain(provider);
      expect(logger.error).toHaveBeenCalledWith(
        'Catalog history query failed',
        expect.objectContaining({ errorCode: '57014' }),
      );
      expect(JSON.stringify(logger.error.mock.calls)).not.toContain(secret);
      await assertReadConnectionIdle();
    } finally {
      await blocker.cleanup();
      await db.raw('select 1');
    }
    await assertReusable();
  });
});
