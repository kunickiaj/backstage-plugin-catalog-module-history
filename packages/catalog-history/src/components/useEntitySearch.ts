import { useEffect, useRef, useState } from 'react';
import type {
  HistoryEntityIdentity,
  HistoryEntitySearchRequest,
} from '@kunickiaj/backstage-plugin-catalog-history-common';
import {
  CatalogHistoryApi,
  CatalogHistoryApiError,
} from '../api/CatalogHistoryApi';

const empty = {
  items: [] as HistoryEntityIdentity[],
  more: false,
  status: 'idle' as 'idle' | 'loading' | 'error',
  error: '',
};

function identity(value: unknown): value is HistoryEntityIdentity {
  if (!value || typeof value !== 'object') return false;
  return ['entityRef', 'kind', 'namespace', 'name'].every(
    key => typeof (value as Record<string, unknown>)[key] === 'string',
  );
}

export function useEntitySearch(props: {
  api?: CatalogHistoryApi;
  context: HistoryEntitySearchRequest;
  query: string;
  open: boolean;
}) {
  const [result, setResult] = useState(empty);
  const [attempt, setAttempt] = useState(0);
  const contextKey = JSON.stringify(props.context);
  const key = JSON.stringify([contextKey, props.query, attempt]);
  const current = useRef({ api: props.api, key });
  const resultIdentity = useRef(current.current);
  const unsupported = useRef<CatalogHistoryApi>();
  if (current.current.api !== props.api) unsupported.current = undefined;
  current.current = { api: props.api, key };

  useEffect(() => {
    const api = props.api;
    let cancelled = false;
    const valid = () =>
      !cancelled && current.current.api === api && current.current.key === key;
    if (!props.open || !api?.getEntities || unsupported.current === api)
      return undefined;
    resultIdentity.current = { api, key };
    setResult({ ...empty, status: 'loading' });
    async function load() {
      try {
        const context: HistoryEntitySearchRequest = JSON.parse(contextKey);
        const page = await api!.getEntities!({
          ...context,
          prefix: props.query || undefined,
          limit: 25,
        });
        if (!valid()) return;
        if (
          !Array.isArray(page?.items) ||
          !page.items.every(identity) ||
          (page.nextCursor !== undefined && typeof page.nextCursor !== 'string')
        )
          throw new Error('Invalid entity suggestions');
        setResult({
          ...empty,
          items: Array.from(
            new Map(page.items.map(item => [item.entityRef, item])).values(),
          ),
          more: Boolean(page.nextCursor),
        });
      } catch (error) {
        if (!valid()) return;
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
          ...empty,
          status: 'error',
          error: access
            ? 'You do not have access to entity suggestions. Check your access and retry.'
            : 'Entity suggestions could not be loaded. Retry to try again.',
        });
      }
    }
    const timer = setTimeout(load, props.query ? 300 : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [props.api, props.open, props.query, contextKey, key]);

  const matches =
    resultIdentity.current.api === props.api &&
    resultIdentity.current.key === key;
  return {
    ...(matches
      ? result
      : {
          ...empty,
          status: props.open ? ('loading' as const) : ('idle' as const),
        }),
    unsupported: !props.api?.getEntities || unsupported.current === props.api,
    retry: () => setAttempt(value => value + 1),
  };
}
