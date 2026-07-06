import { JsonObject } from '@backstage/types';

export type MutationType = 'full' | 'delta';

export type CaptureSource = 'provider' | 'processing' | 'reconciler';

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
  relations?: Array<{ type: string; targetRef: string }>;
  statusItems?: JsonObject[];
  orphan?: boolean;
};

export type CycleInput = {
  cycleId: string;
  provider: string;
  source: CaptureSource;
  mutationType: MutationType;
  startedAt: Date;
  finishedAt: Date;
  inserts: EntityRow[];
  updates: EntityRow[];
  deletes: string[];
  unchangedCount: number;
};
