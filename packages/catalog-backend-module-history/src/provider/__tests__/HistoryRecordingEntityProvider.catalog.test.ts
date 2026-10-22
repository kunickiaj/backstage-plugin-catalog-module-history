import { dirname, join } from 'node:path';
import { LoggerService } from '@backstage/backend-plugin-api';
import { mockServices, TestDatabases } from '@backstage/backend-test-utils';
import { Entity } from '@backstage/catalog-model';
import {
  EntityProvider,
  EntityProviderConnection,
  EntityProviderMutation,
} from '@backstage/plugin-catalog-node';
import { InMemoryHistoryStore } from '@kunickiaj/backstage-plugin-catalog-history-node/testUtils';
import { Knex } from 'knex';
import { HistoryRecordingEntityProvider } from '../HistoryRecordingEntityProvider';

type Entry = Extract<
  EntityProviderMutation,
  { type: 'full' }
>['entities'][number];
type CatalogRow = {
  entity_id: string;
  entity_ref: string;
  location_key: string | null;
  unprocessed_entity: string;
  unprocessed_hash: string;
};

// Catalog 3.9.0 is pinned as a devDependency: its public API does not expose
// provider persistence in isolation. Keep these internal entry points here so
// upgrades must verify the real connection, migrations, and database contract.
const catalogRoot = dirname(
  require.resolve('@backstage/plugin-catalog-backend/package.json'),
);
const { DefaultProviderDatabase } = require(
  join(catalogRoot, 'dist/database/DefaultProviderDatabase.cjs.js'),
) as {
  DefaultProviderDatabase: new (options: {
    database: Knex;
    logger: LoggerService;
  }) => object;
};
const { connectEntityProviders } = require(
  join(catalogRoot, 'dist/processing/connectEntityProviders.cjs.js'),
) as {
  connectEntityProviders: (
    database: object,
    providers: { provider: EntityProvider }[],
  ) => Promise<void>;
};

function entry(name: string, etag?: string, locationKey?: string): Entry {
  const entity: Entity = {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Component',
    metadata: { name, ...(etag === undefined ? {} : { etag }) },
    spec: {
      type: 'service',
      lifecycle: 'experimental',
      owner: 'group:default/example',
    },
  };
  return { entity, ...(locationKey === undefined ? {} : { locationKey }) };
}

describe('HistoryRecordingEntityProvider catalog persistence', () => {
  const databases = TestDatabases.create({
    ids: ['SQLITE_3'],
    disableDocker: true,
  });
  let database: Knex;

  beforeEach(async () => {
    database = await databases.init('SQLITE_3');
    await database.raw('PRAGMA foreign_keys = ON');
    await database.migrate.latest({
      directory: join(catalogRoot, 'migrations'),
    });
  });

  async function setup(initial: Entry[], convertFullToDelta = true) {
    const logger = mockServices.logger.mock();
    const store = new InMemoryHistoryStore();
    let connection: EntityProviderConnection | undefined;
    const inner: EntityProvider = {
      getProviderName: () => 'example-provider',
      connect: async conn => {
        connection = conn;
        await conn.applyMutation({ type: 'full', entities: initial });
      },
    };
    const provider = new HistoryRecordingEntityProvider({
      inner,
      store,
      logger,
      convertFullToDelta,
    });
    const providerDatabase = new DefaultProviderDatabase({ database, logger });
    await connectEntityProviders(providerDatabase, [{ provider }]);
    if (!connection) throw new Error('Provider did not connect');
    return { connection, store, logger, providerDatabase };
  }

  function row(name: string): Promise<CatalogRow | undefined> {
    return database<CatalogRow>('refresh_state')
      .where('entity_ref', `component:default/${name}`)
      .first();
  }

  async function seedChild(root: CatalogRow) {
    await database('refresh_state').insert({
      ...root,
      entity_id: 'synthetic-child-id',
      entity_ref: 'component:default/child',
      unprocessed_entity: JSON.stringify(entry('child', 'c1').entity),
    });
    await database('refresh_state_references').insert({
      source_entity_ref: root.entity_ref,
      target_entity_ref: 'component:default/child',
    });
  }

  it('updates keyed roots without recreating them or pruning descendants, and removes missing roots', async () => {
    // Arrange: a real full establishes roots; seed a processor-owned child.
    const stable = entry('stable', 's1', 'example:stable');
    const { connection, store, logger } = await setup([
      entry('root', 'r1', 'example:root'),
      stable,
      entry('removed', 'd1', 'example:removed'),
    ]);
    const before = (await row('root'))!;
    const stableBefore = (await row('stable'))!;
    await seedChild(before);
    const changed = entry('root', 'r2', 'example:root');
    const added = entry('new', 'n1', 'example:new');

    // Act: the second full is converted before reaching catalog persistence.
    await connection.applyMutation({
      type: 'full',
      entities: [changed, added, stable],
    });

    // Assert: catalog updates in place; an unchanged root is not recreated.
    const after = (await row('root'))!;
    expect(after.entity_id).toBe(before.entity_id);
    expect(after.location_key).toBe('example:root');
    expect(JSON.parse(after.unprocessed_entity)).toEqual(changed.entity);
    expect(await row('child')).toMatchObject({
      entity_id: 'synthetic-child-id',
    });
    expect(await row('stable')).toEqual(stableBefore);
    expect(await row('new')).toMatchObject({ location_key: 'example:new' });
    expect(await row('removed')).toBeUndefined();
    expect(store.cycles[1]).toMatchObject({
      mutationType: 'full',
      deletes: ['component:default/removed'],
      unchangedCount: 1,
    });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('persists same-etag content changes while retaining the root and child', async () => {
    // Arrange: history etags alone cannot detect this spec change.
    const initial = entry('root', 'same-etag', 'example:root');
    const { connection, store, logger } = await setup([initial]);
    const before = (await row('root'))!;
    await seedChild(before);
    const changed: Entry = {
      ...initial,
      entity: {
        ...initial.entity,
        spec: { ...initial.entity.spec, type: 'api' },
      },
    };

    // Act.
    await connection.applyMutation({ type: 'full', entities: [changed] });

    // Assert: the catalog hashes the full entity, independently of history.
    const after = (await row('root'))!;
    expect(JSON.parse(after.unprocessed_entity)).toEqual(changed.entity);
    expect(after.unprocessed_hash).not.toBe(before.unprocessed_hash);
    expect(after.entity_id).toBe(before.entity_id);
    expect(after.location_key).toBe(before.location_key);
    expect(await row('child')).toMatchObject({
      entity_id: 'synthetic-child-id',
    });
    expect(store.cycles[1]).toMatchObject({ updates: [], unchangedCount: 1 });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('persists an apiVersion-only change without a metadata etag', async () => {
    // Arrange: the history row fallback hash omits apiVersion.
    const initial = entry('root', undefined, 'example:root');
    const { connection, store, logger } = await setup([initial]);
    const before = (await row('root'))!;
    const changed: Entry = {
      ...initial,
      entity: { ...initial.entity, apiVersion: 'backstage.io/v1beta1' },
    };

    // Act.
    await connection.applyMutation({ type: 'full', entities: [changed] });

    // Assert: an unchanged history row must not suppress a catalog write.
    const after = (await row('root'))!;
    expect(JSON.parse(after.unprocessed_entity)).toEqual(changed.entity);
    expect(after.unprocessed_hash).not.toBe(before.unprocessed_hash);
    expect(after.entity_id).toBe(before.entity_id);
    expect(after.location_key).toBe(before.location_key);
    expect(store.cycles[1]).toMatchObject({ updates: [], unchangedCount: 1 });
    expect(logger.error).not.toHaveBeenCalled();
  });

  describe.each([
    { change: 'introduction', beforeKey: undefined, afterKey: 'example:first' },
    {
      change: 'replacement',
      beforeKey: 'example:first',
      afterKey: 'example:second',
    },
    { change: 'removal', beforeKey: 'example:first', afterKey: undefined },
  ])('location-key $change at the same etag', ({ beforeKey, afterKey }) => {
    it.each([true, false])(
      'recreates the root and prunes children with conversion=%s, matching real full semantics',
      async convertFullToDelta => {
        // Arrange: cover both converted and native fulls against the same DB API.
        const { connection, store, logger } = await setup(
          [entry('root', 'same-etag', beforeKey)],
          convertFullToDelta,
        );
        const before = (await row('root'))!;
        await seedChild(before);
        const changed = entry('root', 'same-etag', afterKey);

        // Act: only the deferred entry's locationKey changes.
        await connection.applyMutation({ type: 'full', entities: [changed] });

        // Assert: key changes intentionally replace roots and prune descendants.
        const after = (await row('root'))!;
        expect(after.location_key).toBe(afterKey ?? null);
        expect(after.entity_id).not.toBe(before.entity_id);
        expect(JSON.parse(after.unprocessed_entity)).toEqual(changed.entity);
        expect(await row('child')).toBeUndefined();
        expect(store.cycles[1]).toMatchObject({
          updates: [],
          unchangedCount: 1,
        });
        expect(logger.error).not.toHaveBeenCalled();
      },
    );
  });

  it('applies native deltas and scopes refs-only removals to their provider', async () => {
    // Arrange: another provider owns a separate root in the same catalog DB.
    const { connection, store, logger, providerDatabase } = await setup([
      entry('root', 'r1', 'example:root'),
    ]);
    const foreign = entry('foreign', 'f1', 'example:foreign');
    await connectEntityProviders(providerDatabase, [
      {
        provider: {
          getProviderName: () => 'other-provider',
          connect: async conn => {
            await conn.applyMutation({ type: 'full', entities: [foreign] });
          },
        },
      },
    ]);
    const foreignBefore = (await row('foreign'))!;
    const webhook = entry('webhook', 'w1', 'example:webhook');
    await connection.applyMutation({
      type: 'delta',
      added: [webhook],
      removed: [],
    });
    const webhookBefore = (await row('webhook'))!;
    const changed = entry('webhook', 'w2', 'example:webhook');

    // Act: update one owned root, delete another, and try deleting a foreign ref.
    await connection.applyMutation({
      type: 'delta',
      added: [changed],
      removed: [
        { entityRef: 'component:default/root' },
        { entityRef: 'component:default/foreign' },
      ],
    });

    // Assert: native delta writes keep keys and cannot delete another provider's root.
    const webhookAfter = (await row('webhook'))!;
    expect(webhookAfter.entity_id).toBe(webhookBefore.entity_id);
    expect(webhookAfter.location_key).toBe('example:webhook');
    expect(JSON.parse(webhookAfter.unprocessed_entity)).toEqual(changed.entity);
    expect(await row('root')).toBeUndefined();
    expect(await row('foreign')).toEqual(foreignBefore);
    expect(store.cycles[2]).toMatchObject({ mutationType: 'delta' });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('rejects malformed native delta entries without changing catalog or history', async () => {
    // Arrange: catalog envelope validation runs before its transaction writes.
    const { connection, store } = await setup([
      entry('root', 'r1', 'example:root'),
    ]);
    const before = (await row('root'))!;
    const malformed = entry('invalid', 'i1', 'example:invalid');
    malformed.entity.apiVersion = '';

    // Act.
    const mutation = connection.applyMutation({
      type: 'delta',
      added: [malformed],
      removed: [{ entityRef: 'component:default/root' }],
    });

    // Assert: failed catalog writes must not become successful history cycles.
    await expect(mutation).rejects.toThrow('Malformed entity envelope');
    expect(await row('root')).toEqual(before);
    expect(await row('invalid')).toBeUndefined();
    expect(store.cycles).toHaveLength(1);
  });
});
