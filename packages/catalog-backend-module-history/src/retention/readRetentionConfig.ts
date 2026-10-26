import { type Config, readDurationFromConfig } from '@backstage/config';
import { durationToMilliseconds } from '@backstage/types';

const CONFIG_KEY = 'catalog.history.retention';
const MIN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 1000;
const MAX_BATCH_SIZE = 10000;

/** Validated settings for the scheduled retention task. */
export type RetentionSettings = {
  maxAgeMs: number;
  dryRun: boolean;
  batchSize: number;
};

function readMaxAgeMs(config: Config): number {
  const key = `${CONFIG_KEY}.maxAge`;
  if (!config.has('maxAge')) {
    throw new Error(
      `${key} is required when ${CONFIG_KEY}.enabled is true; set a window such as { days: 90 }`,
    );
  }

  let maxAgeMs: number;
  try {
    maxAgeMs = durationToMilliseconds(
      readDurationFromConfig(config, { key: 'maxAge' }),
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid ${key}: ${reason}`);
  }

  if (!Number.isFinite(maxAgeMs) || maxAgeMs < MIN_MAX_AGE_MS) {
    throw new Error(`${key} must be at least 1 day`);
  }
  return maxAgeMs;
}

function readBatchSize(config: Config): number {
  const key = `${CONFIG_KEY}.batchSize`;
  let batchSize: number | undefined;
  try {
    batchSize = config.getOptionalNumber('batchSize');
  } catch {
    batchSize = Number.NaN;
  }
  if (batchSize === undefined) {
    return DEFAULT_BATCH_SIZE;
  }
  if (
    !Number.isInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > MAX_BATCH_SIZE
  ) {
    throw new Error(
      `${key} must be an integer from 1 through ${MAX_BATCH_SIZE}`,
    );
  }
  return batchSize;
}

/**
 * Reads `catalog.history.retention` from the module's `catalog.history`
 * config. Returns undefined when retention is off, so callers schedule
 * nothing. Throws a startup error naming the bad key for invalid settings.
 */
export function readRetentionConfig(
  moduleConfig: Config | undefined,
): RetentionSettings | undefined {
  const config = moduleConfig?.getOptionalConfig('retention');
  if (config?.getOptionalBoolean('enabled') !== true) {
    return undefined;
  }
  return {
    maxAgeMs: readMaxAgeMs(config),
    dryRun: config.getOptionalBoolean('dryRun') ?? true,
    batchSize: readBatchSize(config),
  };
}
