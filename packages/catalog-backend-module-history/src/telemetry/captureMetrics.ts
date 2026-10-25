import { performance } from 'node:perf_hooks';
import type { MetricsService } from '@backstage/backend-plugin-api/alpha';

type Source = 'provider' | 'processing' | 'reconciler';
type Operation =
  | 'provider_mutation'
  | 'processing_entity'
  | 'processing_flush'
  | 'reconcile';
type Outcome = 'success' | 'error';
type Stop = (outcome: Outcome) => void;

// Telemetry must never change capture behavior, including when the SDK throws.
function isolated<T>(action: () => T): T | undefined {
  try {
    return action();
  } catch {
    return undefined;
  }
}

const noopStop: Stop = () => {};

export function createCaptureMetrics(source: Source, metrics?: MetricsService) {
  if (!metrics) {
    return {
      startOperation: (_operation: Operation): Stop => noopStop,
    };
  }

  const operationDuration = isolated(() =>
    metrics.createHistogram('catalog.history.capture.operation.duration', {
      unit: 's',
      advice: {
        explicitBucketBoundaries: [
          0.0001, 0.001, 0.01, 0.1, 1, 5, 10, 30, 60, 300, 600,
        ],
      },
    }),
  );

  function startOperation(operation: Operation): Stop {
    const started = performance.now();
    let finished = false;
    return outcome => {
      if (finished) return;
      finished = true;
      const duration = (performance.now() - started) / 1_000;
      isolated(() =>
        operationDuration?.record(duration, { source, operation, outcome }),
      );
    };
  }

  return {
    startOperation,
  };
}
