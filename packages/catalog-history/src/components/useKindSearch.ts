import { useEffect, useRef, useState } from 'react';
import {
  CatalogHistoryApi,
  CatalogHistoryApiError,
} from '../api/CatalogHistoryApi';

const empty = {
  items: [] as string[],
  nextCursor: undefined as string | undefined,
  status: 'idle' as 'idle' | 'loading' | 'error',
  error: '',
};

export function useKindSearch(props: {
  api?: CatalogHistoryApi;
  query: string;
  open: boolean;
}) {
  const [result, setResult] = useState(empty);
  const [request, setRequest] = useState({
    query: props.query,
    api: props.api,
    cursor: undefined as string | undefined,
    attempt: 0,
  });
  const current = useRef({ api: props.api, query: props.query });
  const resultIdentity = useRef(current.current);
  const latest = useRef(result);
  const unsupported = useRef<CatalogHistoryApi>();
  const settled = useRef<{
    api?: CatalogHistoryApi;
    query: string;
    cursor?: string;
    attempt: number;
  }>();
  const changed =
    current.current.api !== props.api || current.current.query !== props.query;
  if (current.current.api !== props.api) unsupported.current = undefined;
  if (changed)
    setRequest(previous => ({
      api: props.api,
      query: props.query,
      cursor: undefined,
      attempt: previous.attempt + 1,
    }));
  current.current = { api: props.api, query: props.query };
  const cursor =
    !changed && request.query === props.query && request.api === props.api
      ? request.cursor
      : undefined;

  useEffect(() => {
    const api = props.api;
    const query = props.query;
    let cancelled = false;
    const valid = () =>
      !cancelled &&
      current.current.api === api &&
      current.current.query === query;
    if (!props.open || !api?.getKinds || unsupported.current === api)
      return undefined;
    const completed = settled.current;
    if (
      completed?.api === api &&
      completed.query === query &&
      completed.cursor === cursor &&
      completed.attempt === request.attempt
    )
      return undefined;
    const finish = () => {
      settled.current = { api, query, cursor, attempt: request.attempt };
    };
    const base = cursor ? latest.current : empty;
    resultIdentity.current = { api, query };
    setResult({ ...base, status: 'loading', error: '' });
    async function load() {
      try {
        const page = await api!.getKinds!({
          prefix: query || undefined,
          limit: 25,
          cursor,
        });
        if (!valid()) return;
        if (
          !Array.isArray(page?.items) ||
          !page.items.every(item => typeof item === 'string') ||
          (page.nextCursor !== undefined && typeof page.nextCursor !== 'string')
        )
          throw new Error('Invalid kind suggestions');
        const next = {
          ...empty,
          items: Array.from(new Set([...base.items, ...page.items])),
          nextCursor: page.nextCursor,
        };
        latest.current = next;
        finish();
        setResult(next);
      } catch (error) {
        if (!valid()) return;
        finish();
        if (
          error instanceof CatalogHistoryApiError &&
          [404, 501].includes(error.status)
        ) {
          unsupported.current = api;
          setResult({ ...empty });
          return;
        }
        const access =
          error instanceof CatalogHistoryApiError &&
          [401, 403].includes(error.status);
        setResult({
          ...base,
          status: 'error',
          error: access
            ? 'You do not have access to kind suggestions. Check your access and retry.'
            : 'Kind suggestions could not be loaded. Retry to try again.',
        });
      }
    }
    const timer = setTimeout(load, query && !cursor ? 300 : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [props.api, props.query, props.open, cursor, request.attempt]);

  function fetch(nextCursor?: string) {
    setRequest(previous => ({
      api: props.api,
      query: props.query,
      cursor: nextCursor,
      attempt: previous.attempt + 1,
    }));
  }
  const matches =
    resultIdentity.current.api === props.api &&
    resultIdentity.current.query === props.query;
  return {
    ...(matches
      ? result
      : {
          ...empty,
          status: props.open ? ('loading' as const) : ('idle' as const),
        }),
    unsupported: !props.api?.getKinds || unsupported.current === props.api,
    retry: () => fetch(cursor),
    loadMore: () => {
      if (result.status === 'idle' && matches && result.nextCursor)
        fetch(result.nextCursor);
    },
  };
}
