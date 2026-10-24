import { performance } from 'node:perf_hooks';
import type { MetricsService } from '@backstage/backend-plugin-api/alpha';

type Source = 'provider' | 'processing' | 'reconciler';
type Operation =
  | 'provider_mutation'
  | 'processing_entity'
  | 'processing_flush'
  | 'reconcile';
type Phase = 'fetch' | 'baseline' | 'prepare' | 'forward' | 'record';
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
      startPhase: (_phase: Phase): Stop => noopStop,
    };
  }

  const operations = isolated(() =>
    metrics.createCounter('catalog.history.capture.operations', {
      unit: '{operation}',
    }),
  );
  const operationDuration = isolated(() =>
    metrics.createHistogram('catalog.history.capture.operation.duration', {
      unit: 's',
    }),
  );
  const phases = isolated(() =>
    metrics.createCounter('catalog.history.capture.phases', {
      unit: '{phase}',
    }),
  );
  const phaseDuration = isolated(() =>
    metrics.createHistogram('catalog.history.capture.phase.duration', {
      unit: 's',
    }),
  );

  function start(label: { operation: Operation } | { phase: Phase }): Stop {
    const started = performance.now();
    let finished = false;
    return outcome => {
      if (finished) return;
      finished = true;
      const duration = (performance.now() - started) / 1_000;
      const attributes = { source, ...label, outcome };
      if ('operation' in label) {
        isolated(() => operations?.add(1, attributes));
        isolated(() => operationDuration?.record(duration, attributes));
      } else {
        isolated(() => phases?.add(1, attributes));
        isolated(() => phaseDuration?.record(duration, attributes));
      }
    };
  }

  return {
    startOperation: (operation: Operation): Stop => start({ operation }),
    startPhase: (phase: Phase): Stop => start({ phase }),
  };
}
