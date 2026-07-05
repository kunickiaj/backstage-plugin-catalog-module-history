import { randomUUID } from 'node:crypto';
import type { LoggerService } from '@backstage/backend-plugin-api';
import type { Entity } from '@backstage/catalog-model';
import {
  type CatalogProcessor,
  type CatalogProcessorCache,
  type CatalogProcessorEmit,
  type LocationSpec,
} from '@backstage/plugin-catalog-node';
import { entityToRow } from '../mapping/entityToRow';
import type { HistoryStore } from '../store/HistoryStore';
import type { EntityRow } from '../store/types';

const PROCESSING_PROVIDER = 'processing';
const DEFAULT_MAX_BATCH_SIZE = 500;
const DEFAULT_FLUSH_INTERVAL_MS = 10_000;

export type HistoryRecordingCatalogProcessorOptions = {
  store: HistoryStore;
  logger: LoggerService;
  maxBatchSize?: number;
  flushIntervalMs?: number;
};

/**
 * Records processor-layer catalog history without changing catalog behavior.
 *
 * Catalog processors cannot observe deletes; deletion truth comes from the
 * provider and reconciler layers. Registration order across independently-added
 * backend modules is also not enforceable, so this layer may observe pre-final
 * content. The reconciler layer remains the backstop; see
 * docs/adr/2026-07-01-entity-capture-layers.md.
 */
export class HistoryRecordingCatalogProcessor implements CatalogProcessor {
  private readonly maxBatchSize: number;
  private readonly flushIntervalMs: number;
  private currentEtags: Map<string, string> | undefined;
  private seedPromise: Promise<Map<string, string>> | undefined;
  private inserts: EntityRow[] = [];
  private updates: EntityRow[] = [];
  private unchangedCount = 0;
  private batchStartedAt: Date | undefined;
  private flushTimer: NodeJS.Timeout | undefined;
  private flushPromise: Promise<void> | undefined;

  constructor(
    private readonly options: HistoryRecordingCatalogProcessorOptions,
  ) {
    this.maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  }

  getProcessorName(): string {
    return 'HistoryRecordingCatalogProcessor';
  }

  async postProcessEntity(
    entity: Entity,
    _location: LocationSpec,
    _emit: CatalogProcessorEmit,
    _cache: CatalogProcessorCache,
  ): Promise<Entity> {
    try {
      const row = entityToRow(entity);
      const etags = await this.getCurrentEtags();
      const previousEtag = etags.get(row.entityRef);

      if (previousEtag === row.etag) {
        this.unchangedCount += 1;
        return entity;
      }

      if (previousEtag === undefined) {
        this.inserts.push(row);
      } else {
        this.updates.push(row);
      }
      etags.set(row.entityRef, row.etag);
      this.ensureBatchStarted();

      if (this.bufferLength() >= this.maxBatchSize) {
        await this.flush();
      }
    } catch (error) {
      this.options.logger.warn(
        'Failed to record processor-layer catalog history',
        error as Error,
      );
    }

    return entity;
  }

  async flush(): Promise<void> {
    if (!this.flushPromise) {
      this.flushPromise = this.flushBuffered().finally(() => {
        this.flushPromise = undefined;
      });
    }
    await this.flushPromise;
  }

  async stop(): Promise<void> {
    this.clearFlushTimer();
    await this.flush();
  }

  private async getCurrentEtags(): Promise<Map<string, string>> {
    if (this.currentEtags) {
      return this.currentEtags;
    }

    if (!this.seedPromise) {
      this.seedPromise = this.options.store
        .loadAllCurrentEtags({ source: 'processing' })
        .then(current => {
          const etags = new Map<string, string>();
          for (const [entityRef, value] of current) {
            etags.set(entityRef, value.etag);
          }
          this.currentEtags = etags;
          return etags;
        })
        .finally(() => {
          this.seedPromise = undefined;
        });
    }

    return this.seedPromise;
  }

  private ensureBatchStarted(): void {
    if (!this.batchStartedAt) {
      this.batchStartedAt = new Date();
      this.flushTimer = setTimeout(() => {
        void this.flush();
      }, this.flushIntervalMs);
      this.flushTimer.unref?.();
    }
  }

  private async flushBuffered(): Promise<void> {
    if (this.bufferLength() === 0) {
      this.unchangedCount = 0;
      return;
    }

    const inserts = this.inserts;
    const updates = this.updates;
    const unchangedCount = this.unchangedCount;
    const startedAt = this.batchStartedAt ?? new Date();

    this.inserts = [];
    this.updates = [];
    this.unchangedCount = 0;
    this.batchStartedAt = undefined;
    this.clearFlushTimer();

    try {
      await this.options.store.recordCycle({
        cycleId: randomUUID(),
        provider: PROCESSING_PROVIDER,
        source: 'processing',
        mutationType: 'delta',
        startedAt,
        finishedAt: new Date(),
        inserts,
        updates,
        deletes: [],
        unchangedCount,
      });
    } catch (error) {
      // History for this window is intentionally forfeited on store error:
      // requeueing would grow the buffer unboundedly during an outage, and
      // processor-layer capture is best-effort by design — the reconciler
      // layer is the backstop for anything missed here. Logged at error so
      // sustained store outages are alertable.
      this.options.logger.error(
        'Failed to flush processor-layer catalog history; dropping this batch',
        error as Error,
      );
    }
  }

  private bufferLength(): number {
    return this.inserts.length + this.updates.length;
  }

  private clearFlushTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
  }
}
