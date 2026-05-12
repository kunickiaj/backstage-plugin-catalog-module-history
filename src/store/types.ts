import { JsonObject } from '@backstage/types';

export type MutationType = 'full' | 'delta';

export type EntityRow = {
  entityRef: string;
  kind: string;
  namespace: string;
  name: string;
  etag: string;
  displayName?: string;
  email?: string;
  parent?: string;
  memberOf?: string[];
  owner?: string;
  metadata: JsonObject;
  spec: JsonObject;
};

export type CycleInput = {
  cycleId: string;
  provider: string;
  mutationType: MutationType;
  startedAt: Date;
  finishedAt: Date;
  inserts: EntityRow[];
  updates: EntityRow[];
  deletes: string[];
  unchangedCount: number;
};
