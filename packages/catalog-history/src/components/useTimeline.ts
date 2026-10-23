import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  HistoryEntityTimelineRequest,
  HistoryEntityTimelineResponse,
} from '@kunickiaj/backstage-plugin-catalog-history-common';
import type { CatalogHistoryApi } from '../api/CatalogHistoryApi';

type TimelineState = HistoryEntityTimelineResponse & {
  loading: boolean;
  error?: unknown;
};

// The caller keys this hook's component by entity and applied filters.
export function useTimeline(
  api: CatalogHistoryApi,
  request: HistoryEntityTimelineRequest,
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
      api
        .getEntityTimeline({ ...request, cursor })
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
    [api, request],
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
