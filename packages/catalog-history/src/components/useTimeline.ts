import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  HistoryEntityTimelineRequest,
  HistoryChangeFeedRequest,
  HistoryEntityTimelineResponse,
} from '@kunickiaj/backstage-plugin-catalog-history-common';
import { CatalogHistoryApiError } from '../api/CatalogHistoryApi';
import type { CatalogHistoryApi } from '../api/CatalogHistoryApi';

export type HistoryTimelineScope =
  | { scope?: 'entity'; request: HistoryEntityTimelineRequest }
  | { scope: 'all'; request: HistoryChangeFeedRequest };

type TimelineState = HistoryEntityTimelineResponse & {
  loading: boolean;
  error?: unknown;
};

// The caller keys this hook's component by entity and applied filters.
export function useTimeline(
  api: CatalogHistoryApi,
  request: HistoryChangeFeedRequest,
  scope: 'entity' | 'all' = 'entity',
) {
  const [state, setState] = useState<TimelineState>({
    items: [],
    loading: true,
  });
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const busy = useRef(false);
  const retryCursor = useRef<string>();

  const load = useCallback(
    (cursor?: string) => {
      if (busy.current) return;
      busy.current = true;
      retryCursor.current = cursor;
      const current = generation.current;
      setState(previous => ({ ...previous, loading: true, error: undefined }));
      const pageRequest = { ...request, cursor };
      let response: Promise<HistoryEntityTimelineResponse>;
      if (scope === 'all') {
        response = api.getChangeFeed
          ? api.getChangeFeed(pageRequest)
          : Promise.reject(new CatalogHistoryApiError(501));
      } else if (request.entityRef) {
        response = api.getEntityTimeline({
          ...pageRequest,
          entityRef: request.entityRef,
        });
      } else {
        response = Promise.reject(new CatalogHistoryApiError(400));
      }
      response
        .then(page => {
          if (generation.current !== current) return;
          setState(previous => ({
            ...page,
            items: cursor ? [...previous.items, ...page.items] : page.items,
            loading: false,
          }));
        })
        .catch(error => {
          if (generation.current === current)
            setState(previous => ({ ...previous, loading: false, error }));
        })
        .finally(() => {
          if (generation.current === current) busy.current = false;
        });
    },
    [api, request, scope],
  );

  useEffect(() => {
    load();
    return () => {
      generation.current += 1;
      busy.current = false;
    };
  }, [load, revision]);

  return {
    ...state,
    older: () => load(state.nextCursor),
    retry: () => load(retryCursor.current),
    refresh: () => setRevision(value => value + 1),
  };
}
