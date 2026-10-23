import type { Entity } from '@backstage/catalog-model';
import type {
  HistoryDiffEntry,
  HistoryEntitySnapshot,
  HistoryEntityVersion,
} from '@kunickiaj/backstage-plugin-catalog-history-common';

export const previewEntity: Entity = {
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Component',
  metadata: {
    name: 'example-service',
    namespace: 'default',
    description: 'Synthetic catalog history preview',
  },
  spec: {
    type: 'service',
    owner: 'group:default/platform',
    lifecycle: 'production',
  },
};

export const previewEntityRef = 'component:default/example-service';

const snapshots: Record<string, HistoryEntitySnapshot> = {
  'synthetic-a': snapshot('group:default/platform', 'experimental'),
  'synthetic-b': snapshot('group:default/services', 'production'),
  'synthetic-c': {
    ...snapshot('group:default/platform', 'production'),
    statusItems: [
      {
        type: 'backstage.io/catalog-processing',
        level: 'warning',
        message: 'Synthetic processing warning for preview only',
      },
    ],
  },
};

function snapshot(owner: string, lifecycle: string): HistoryEntitySnapshot {
  return {
    entityRef: previewEntityRef,
    kind: 'Component',
    namespace: 'default',
    name: 'example-service',
    owner,
    metadata: {
      name: 'example-service',
      namespace: 'default',
      description: 'Synthetic catalog history preview',
    },
    spec: { type: 'service', owner, lifecycle },
    relations: [{ type: 'ownedBy', targetRef: owner }],
    statusItems: [],
  };
}

function record(
  day: number,
  source: HistoryEntityVersion['source'],
  provider: string,
  op: HistoryEntityVersion['op'],
  etag?: string,
  summary: HistoryEntityVersion['summary'] = {},
): HistoryEntityVersion {
  return {
    id: `synthetic-event-${day}`,
    cycleId: `synthetic-cycle-${day}`,
    entityRef: previewEntityRef,
    source,
    provider,
    op,
    changedAt: `2026-10-${String(day).padStart(2, '0')}T12:00:00.000Z`,
    etag,
    summary,
    ...(etag ? { snapshot: { ...snapshots[etag], etag } } : {}),
  };
}

/** Newest first. Days 3–5 deliberately record A → B → A with distinct IDs. */
export const previewRecords: readonly HistoryEntityVersion[] = [
  record(10, 'reconciler', 'reconciler', 'update', 'synthetic-c', {
    ownerChanged: true,
    statusChanged: true,
  }),
  record(9, 'processing', 'processing', 'update', 'synthetic-b', {
    ownerChanged: true,
  }),
  record(8, 'provider', 'example-discovery', 'insert', 'synthetic-a'),
  record(7, 'provider', 'example-discovery', 'delete'),
  record(6, 'reconciler', 'reconciler', 'update', 'synthetic-b'),
  record(5, 'provider', 'example-discovery', 'update', 'synthetic-a', {
    ownerChanged: true,
  }),
  record(4, 'provider', 'example-discovery', 'update', 'synthetic-b', {
    ownerChanged: true,
  }),
  record(3, 'provider', 'example-discovery', 'update', 'synthetic-a'),
  record(2, 'processing', 'processing', 'update', 'synthetic-a'),
  record(1, 'provider', 'example-bootstrap', 'insert', 'synthetic-a'),
];

// Explicit demonstration deltas, not a second implementation of the backend diff.
const ownerToServices: HistoryDiffEntry[] = [
  {
    path: ['owner'],
    op: 'replace',
    before: 'group:default/platform',
    after: 'group:default/services',
  },
  {
    path: ['relations'],
    op: 'replace',
    before: snapshots['synthetic-a'].relations,
    after: snapshots['synthetic-b'].relations,
  },
  {
    path: ['spec', 'lifecycle'],
    op: 'replace',
    before: 'experimental',
    after: 'production',
  },
  {
    path: ['spec', 'owner'],
    op: 'replace',
    before: 'group:default/platform',
    after: 'group:default/services',
  },
];

export const previewChanges: Readonly<Record<string, HistoryDiffEntry[]>> = {
  'synthetic-event-10': [
    {
      path: ['owner'],
      op: 'replace',
      before: 'group:default/services',
      after: 'group:default/platform',
    },
    {
      path: ['relations'],
      op: 'replace',
      before: snapshots['synthetic-b'].relations,
      after: snapshots['synthetic-c'].relations,
    },
    {
      path: ['spec', 'owner'],
      op: 'replace',
      before: 'group:default/services',
      after: 'group:default/platform',
    },
    {
      path: ['statusItems'],
      op: 'replace',
      before: [],
      after: snapshots['synthetic-c'].statusItems,
    },
  ],
  'synthetic-event-9': ownerToServices,
  'synthetic-event-7': [
    {
      path: ['metadata'],
      op: 'remove',
      before: snapshots['synthetic-a'].metadata,
    },
    { path: ['owner'], op: 'remove', before: snapshots['synthetic-a'].owner },
    {
      path: ['relations'],
      op: 'remove',
      before: snapshots['synthetic-a'].relations,
    },
    { path: ['spec'], op: 'remove', before: snapshots['synthetic-a'].spec },
    {
      path: ['statusItems'],
      op: 'remove',
      before: snapshots['synthetic-a'].statusItems,
    },
  ],
  'synthetic-event-5': ownerToServices.map(change => ({
    ...change,
    before: change.after,
    after: change.before,
  })),
  'synthetic-event-4': ownerToServices,
};
