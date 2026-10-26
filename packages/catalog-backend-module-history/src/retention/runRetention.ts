import type { LoggerService } from '@backstage/backend-plugin-api';
import {
  HistoryRetentionAbortedError,
  type HistoryRetentionCounts,
  type HistoryStore,
} from '@kunickiaj/backstage-plugin-catalog-history-node';
import type { RetentionSettings } from './readRetentionConfig';

/** A store that implements both retention methods. */
export type RetentionStore = Required<
  Pick<HistoryStore, 'planRetention' | 'applyRetention'>
>;

/**
 * Narrows a history store to one that supports scheduled retention. Throws a
 * startup error when either retention method is missing.
 */
export function requireRetentionStore(store: HistoryStore): RetentionStore {
  if (
    typeof store.planRetention !== 'function' ||
    typeof store.applyRetention !== 'function'
  ) {
    throw new Error(
      'catalog.history.retention.enabled requires historyStoreServiceRef to provide planRetention and applyRetention',
    );
  }
  return store as RetentionStore;
}

/** Startup log label for the configured retention mode. */
export function describeRetentionMode(
  settings: RetentionSettings | undefined,
): 'off' | 'dry-run' | 'delete' {
  if (!settings) {
    return 'off';
  }
  return settings.dryRun ? 'dry-run' : 'delete';
}

/**
 * Runs one retention pass. Dry run only counts eligible history. Errors are
 * logged and not rethrown so the scheduler keeps the task registered.
 */
export async function runRetention(options: {
  store: RetentionStore;
  settings: RetentionSettings;
  logger: LoggerService;
  signal: AbortSignal;
}): Promise<void> {
  const { store, settings, logger, signal } = options;
  const cutoff = new Date(Date.now() - settings.maxAgeMs);
  const mode = describeRetentionMode(settings);
  const cutoffIso = cutoff.toISOString();
  logger.info(
    `catalog-history retention started: mode=${mode} cutoff=${cutoffIso}`,
  );

  try {
    let counts: HistoryRetentionCounts;
    if (settings.dryRun) {
      counts = await store.planRetention({ cutoff });
    } else {
      counts = await store.applyRetention({
        cutoff,
        batchSize: settings.batchSize,
        signal,
      });
    }
    logger.info(
      `catalog-history retention finished: mode=${mode} cutoff=${cutoffIso} deletedEntityRows=${counts.deletedEntityRows} supersededRows=${counts.supersededRows} emptyCycles=${counts.emptyCycles}`,
      { mode, cutoff: cutoffIso, ...counts },
    );
  } catch (err) {
    if (err instanceof HistoryRetentionAbortedError) {
      // Timeouts are expected on a large first cleanup; later runs continue.
      logger.warn(
        `catalog-history retention stopped before finishing: mode=${mode} cutoff=${cutoffIso} deletedEntityRows=${err.counts.deletedEntityRows} supersededRows=${err.counts.supersededRows} emptyCycles=${err.counts.emptyCycles}`,
        { mode, cutoff: cutoffIso, ...err.counts },
      );
      return;
    }
    logger.error(
      'catalog-history scheduled retention failed',
      err instanceof Error ? err : { error: String(err) },
    );
  }
}
