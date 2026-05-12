import { Entity } from '@backstage/catalog-model';
import { entityToRow } from '../entityToRow';

describe('entityToRow', () => {
  it('maps a User entity to a row with the profile and memberOf fields populated', () => {
    const entity: Entity = {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'User',
      metadata: {
        name: 'alice',
        namespace: 'default',
        etag: 'alice-etag-v1',
        annotations: {
          'okta.com/user-id': '00u123',
        },
      },
      spec: {
        memberOf: ['group:default/eng', 'group:default/platform'],
        profile: {
          displayName: 'Alice A.',
          email: 'alice@example.com',
          picture: 'https://example.com/alice.png',
        },
      },
    };

    const row = entityToRow(entity);

    expect(row).toMatchObject({
      entityRef: 'user:default/alice',
      kind: 'User',
      namespace: 'default',
      name: 'alice',
      etag: 'alice-etag-v1',
      displayName: 'Alice A.',
      email: 'alice@example.com',
      memberOf: ['group:default/eng', 'group:default/platform'],
    });
    expect(row.owner).toBeUndefined();
    expect(row.parent).toBeUndefined();
    expect(row.metadata).toMatchObject({
      annotations: { 'okta.com/user-id': '00u123' },
    });
    expect(row.spec).toMatchObject({
      profile: { displayName: 'Alice A.' },
    });
  });

  it('maps a Group entity with parent and profile fields', () => {
    const entity: Entity = {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Group',
      metadata: {
        name: 'platform',
        namespace: 'default',
        etag: 'group-etag',
      },
      spec: {
        type: 'team',
        profile: {
          displayName: 'Platform',
          email: 'platform@example.com',
        },
        parent: 'group:default/eng',
        children: ['group:default/api', 'group:default/cli'],
      },
    };

    const row = entityToRow(entity);

    expect(row).toMatchObject({
      entityRef: 'group:default/platform',
      kind: 'Group',
      namespace: 'default',
      name: 'platform',
      etag: 'group-etag',
      displayName: 'Platform',
      email: 'platform@example.com',
      parent: 'group:default/eng',
    });
    expect(row.memberOf).toBeUndefined();
    expect(row.spec).toMatchObject({
      type: 'team',
      parent: 'group:default/eng',
      children: ['group:default/api', 'group:default/cli'],
    });
  });

  it('maps a Component entity with owner', () => {
    const entity: Entity = {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Component',
      metadata: { name: 'checkout-service' },
      spec: {
        type: 'service',
        lifecycle: 'production',
        owner: 'group:default/platform',
        system: 'commerce',
      },
    };

    const row = entityToRow(entity);

    expect(row).toMatchObject({
      entityRef: 'component:default/checkout-service',
      kind: 'Component',
      namespace: 'default',
      name: 'checkout-service',
      owner: 'group:default/platform',
    });
    expect(row.displayName).toBeUndefined();
    expect(row.email).toBeUndefined();
    expect(row.memberOf).toBeUndefined();
    expect(row.parent).toBeUndefined();
  });

  it('lowercases the entity_ref but preserves Kind casing in the kind column', () => {
    const entity: Entity = {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Component',
      metadata: { name: 'MyService', namespace: 'TeamA' },
      spec: { type: 'service', owner: 'group:teama/owners' },
    };

    const row = entityToRow(entity);

    expect(row.entityRef).toBe('component:teama/myservice');
    expect(row.kind).toBe('Component');
    expect(row.namespace).toBe('TeamA');
    expect(row.name).toBe('MyService');
  });

  it('defaults the namespace to "default" when metadata.namespace is omitted', () => {
    const entity: Entity = {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Component',
      metadata: { name: 'no-ns' },
      spec: { type: 'service', owner: 'group:default/team-a' },
    };

    const row = entityToRow(entity);
    expect(row.namespace).toBe('default');
    expect(row.entityRef).toBe('component:default/no-ns');
  });

  it('computes a stable etag from metadata+spec when metadata.etag is absent', () => {
    const a: Entity = {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'User',
      metadata: { name: 'noetag', namespace: 'default' },
      spec: {
        memberOf: ['group:default/a', 'group:default/b'],
        profile: { displayName: 'No Etag' },
      },
    };
    const b: Entity = {
      ...a,
      // Same logical content; field order shuffled to verify stability.
      spec: {
        profile: { displayName: 'No Etag' },
        memberOf: ['group:default/a', 'group:default/b'],
      },
    };

    const rowA = entityToRow(a);
    const rowB = entityToRow(b);
    expect(rowA.etag).toMatch(/^[a-f0-9]{64}$/);
    expect(rowA.etag).toBe(rowB.etag);
  });

  it('produces different etags for different content', () => {
    const a: Entity = {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'User',
      metadata: { name: 'a' },
      spec: { profile: { displayName: 'A' } },
    };
    const b: Entity = {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'User',
      metadata: { name: 'a' },
      spec: { profile: { displayName: 'B' } },
    };

    expect(entityToRow(a).etag).not.toBe(entityToRow(b).etag);
  });

  it('preserves custom annotations losslessly through metadata', () => {
    const entity: Entity = {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'User',
      metadata: {
        name: 'with-annotations',
        annotations: {
          'custom.io/department': 'Engineering',
          'custom.io/cost-center': '4242',
        },
        labels: { team: 'platform' },
        tags: ['oncall'],
      },
      spec: { profile: { displayName: 'A' } },
    };

    const row = entityToRow(entity);
    expect(row.metadata).toMatchObject({
      annotations: {
        'custom.io/department': 'Engineering',
        'custom.io/cost-center': '4242',
      },
      labels: { team: 'platform' },
      tags: ['oncall'],
    });
  });
});
