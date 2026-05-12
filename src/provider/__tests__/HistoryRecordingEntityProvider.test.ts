import { Entity } from '@backstage/catalog-model';
import {
  EntityProvider,
  EntityProviderConnection,
} from '@backstage/plugin-catalog-node';
import { mockServices } from '@backstage/backend-test-utils';
import { InMemoryHistoryStore } from '../../store/__tests__/InMemoryHistoryStore';
import { HistoryRecordingEntityProvider } from '../HistoryRecordingEntityProvider';

class FakeProvider implements EntityProvider {
  applyMutationSpy = jest.fn();

  constructor(
    private readonly name: string,
    private readonly entities: Entity[],
  ) {}

  getProviderName(): string {
    return this.name;
  }

  async connect(connection: EntityProviderConnection): Promise<void> {
    await connection.applyMutation({
      type: 'full',
      entities: this.entities.map(entity => ({ entity })),
    });
  }
}

function fakeConnection(): EntityProviderConnection {
  return {
    applyMutation: jest.fn(),
    refresh: jest.fn(),
  };
}

function user(name: string, etag: string): Entity {
  return {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'User',
    metadata: { name, namespace: 'default', etag },
    spec: { profile: { displayName: name } },
  };
}

function group(name: string, etag: string): Entity {
  return {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Group',
    metadata: { name, namespace: 'default', etag },
    spec: { type: 'team', profile: { displayName: name } },
  };
}

describe('HistoryRecordingEntityProvider', () => {
  it('records a single cycle of inserts when wrapping a fresh full mutation', async () => {
    const store = new InMemoryHistoryStore();
    const inner = new FakeProvider('okta-org', [
      user('alice', 'a1'),
      user('bob', 'b1'),
      group('platform', 'g1'),
    ]);
    const logger = mockServices.logger.mock();
    const wrapper = new HistoryRecordingEntityProvider({
      inner,
      store,
      logger,
    });

    const connection = fakeConnection();
    await wrapper.connect(connection);

    expect(wrapper.getProviderName()).toBe('okta-org');

    expect(connection.applyMutation).toHaveBeenCalledTimes(1);
    const mutation = (connection.applyMutation as jest.Mock).mock.calls[0][0];
    expect(mutation.type).toBe('full');
    expect(mutation.entities).toHaveLength(3);

    expect(store.cycles).toHaveLength(1);
    expect(store.cycles[0]).toMatchObject({
      provider: 'okta-org',
      mutationType: 'full',
      inserts: expect.any(Array),
      updates: [],
      deletes: [],
      unchangedCount: 0,
    });
    expect(store.cycles[0].inserts).toHaveLength(3);
    const refs = store.cycles[0].inserts.map(r => r.entityRef).sort();
    expect(refs).toEqual([
      'group:default/platform',
      'user:default/alice',
      'user:default/bob',
    ]);
  });
});
