import type { JsonObject } from '@backstage/types';
import type {
  HistoryMutationType,
  HistorySource,
} from '@kunickiaj/catalog-history-common';

/**
 * The mutation shape of one recorded cycle.
 *
 * Alias of {@link @kunickiaj/catalog-history-common#HistoryMutationType},
 * kept under the name the backend store contracts have always used.
 *
 * @public
 */
export type MutationType = HistoryMutationType;

/**
 * The capture layer that recorded a cycle or entity row.
 *
 * Alias of {@link @kunickiaj/catalog-history-common#HistorySource}, kept
 * under the name the backend store contracts have always used.
 *
 * @public
 */
export type CaptureSource = HistorySource;

/**
 * One entity change to record in a history cycle.
 *
 * @public
 */
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

/**
 * One full recording cycle to persist atomically.
 *
 * @public
 */
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
