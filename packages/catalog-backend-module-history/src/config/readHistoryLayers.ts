import type { RootConfigService } from '@backstage/backend-plugin-api';

/** Which history read and capture paths the configuration activates. */
export type HistoryLayers = {
  /** `catalog.history.enabled`; false turns every other layer off. */
  enabled: boolean;
  api: boolean;
  provider: boolean;
  processing: boolean;
  reconciler: boolean;
};

/**
 * Reads the history switches with their documented defaults. The master
 * switch wins, so a disabled history reports every layer as off.
 */
export function readHistoryLayers(config: RootConfigService): HistoryLayers {
  const history = config.getOptionalConfig('catalog.history');
  const enabled = history?.getOptionalBoolean('enabled') ?? true;
  const layer = (key: string, fallback: boolean) =>
    enabled && (history?.getOptionalBoolean(`${key}.enabled`) ?? fallback);
  return {
    enabled,
    api: layer('api', false),
    provider: layer('provider', true),
    processing: layer('processing', false),
    reconciler: layer('reconciler', false),
  };
}

/** True when at least one configured path reads or records history. */
export function hasActiveHistoryLayer(layers: HistoryLayers): boolean {
  return (
    layers.api || layers.provider || layers.processing || layers.reconciler
  );
}
