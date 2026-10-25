import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  HistoryCycle,
  HistoryCycleChange,
  HistoryCycleDetailResponse,
} from '@kunickiaj/backstage-plugin-catalog-history-common';
import { CatalogHistoryApiError } from '../api/CatalogHistoryApi';
import type { CatalogHistoryApi } from '../api/CatalogHistoryApi';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sameCycle(actual: string, requested: string) {
  if (typeof actual !== 'string') return false;
  if (uuid.test(actual) && uuid.test(requested))
    return actual.toLowerCase() === requested.toLowerCase();
  return actual === requested;
}

function validate(page: HistoryCycleDetailResponse, cycleId: string) {
  const cycle = page?.cycle;
  if (
    !cycle ||
    !sameCycle(cycle.cycleId, cycleId) ||
    !['provider', 'source', 'mutationType', 'startedAt', 'finishedAt'].every(
      key => typeof cycle[key as keyof HistoryCycle] === 'string',
    ) ||
    !cycle.counts ||
    !['inserted', 'updated', 'deleted', 'unchanged'].every(key => {
      const count = cycle.counts[key as keyof HistoryCycle['counts']];
      return Number.isSafeInteger(count) && count >= 0;
    }) ||
    !Array.isArray(page.changes?.items) ||
    (page.changes.nextCursor !== undefined &&
      typeof page.changes.nextCursor !== 'string') ||
    !page.changes.items.every(
      row =>
        row &&
        sameCycle(row.cycleId, cycleId) &&
        ['id', 'entityRef', 'changedAt', 'source', 'provider', 'op'].every(
          key => typeof row[key as keyof HistoryCycleChange] === 'string',
        ) &&
        row.id.length > 0 &&
        row.entityRef.length > 0,
    )
  )
    throw new Error('Invalid recording cycle response');
  return page;
}

type CycleState = {
  identity?: object;
  cycle?: HistoryCycle;
  items: HistoryCycleChange[];
  nextCursor?: string;
  loading: boolean;
  error?: unknown;
};

const empty: CycleState = { items: [], loading: true };

export function useCycle(api: CatalogHistoryApi, cycleId: string) {
  const [revision, setRevision] = useState(0);
  const identity = useMemo(
    () => ({
      api,
      cycleId,
      revision,
      busy: false,
      generation: 0,
      retryCursor: undefined as string | undefined,
    }),
    [api, cycleId, revision],
  );
  const current = useRef(identity);
  current.current = identity;
  const [stored, setState] = useState<CycleState>(empty);
  // Never show the previous identity while waiting for effect cleanup.
  const state = stored.identity === identity ? stored : empty;
  const load = useCallback(
    async (cursor?: string) => {
      if (identity.busy || current.current !== identity || !cycleId.trim())
        return;
      identity.busy = true;
      identity.retryCursor = cursor;
      const generation = identity.generation;
      const active = () =>
        current.current === identity && generation === identity.generation;
      setState(previous => ({
        ...(previous.identity === identity ? previous : empty),
        identity,
        loading: true,
        error: undefined,
      }));
      try {
        if (!api.getCycle) throw new CatalogHistoryApiError(501);
        const page = validate(
          await api.getCycle({ cycleId, limit: 25, cursor }),
          cycleId,
        );
        if (!active()) return;
        setState(previous => ({
          identity,
          cycle: cursor ? previous.cycle : page.cycle,
          items: Array.from(
            new Map(
              [...(cursor ? previous.items : []), ...page.changes.items].map(
                row => [row.id, row],
              ),
            ).values(),
          ),
          nextCursor: page.changes.nextCursor,
          loading: false,
        }));
      } catch (error) {
        if (active())
          setState(previous => ({ ...previous, loading: false, error }));
      } finally {
        if (active()) identity.busy = false;
      }
    },
    [api, cycleId, identity],
  );
  useEffect(() => {
    void load();
    return () => {
      identity.generation += 1;
      identity.busy = false;
    };
  }, [identity, load]);
  return {
    ...state,
    identity,
    older: () => {
      if (state.nextCursor) void load(state.nextCursor);
    },
    retry: () => {
      void load(identity.retryCursor);
    },
    refresh: () => {
      identity.generation += 1;
      setState(empty);
      setRevision(value => value + 1);
    },
  };
}
