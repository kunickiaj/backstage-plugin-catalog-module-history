import { useEffect, useRef, useState } from 'react';
import type { HistoryProviderSearchRequest } from '@kunickiaj/backstage-plugin-catalog-history-common';
import {
  CatalogHistoryApi,
  CatalogHistoryApiError,
} from '../api/CatalogHistoryApi';

type SearchResult = {
  names: string[];
  more: boolean;
  status: 'idle' | 'loading' | 'error';
  error: string;
  unsupported: boolean;
};
const empty: SearchResult = {
  names: [],
  more: false,
  status: 'idle',
  error: '',
  unsupported: false,
};

export function useProviderSearch(props: {
  api?: CatalogHistoryApi;
  context: HistoryProviderSearchRequest;
  query: string;
  open: boolean;
  resetToken: number;
}) {
  const [result, setResult] = useState(empty);
  const [attempt, setAttempt] = useState(0);
  const contextKey = JSON.stringify(props.context);
  const key = JSON.stringify([
    contextKey,
    props.query,
    props.resetToken,
    attempt,
  ]);
  const current = useRef({ api: props.api, key });
  const resultIdentity = useRef({ api: props.api, key });
  current.current = { api: props.api, key };
  const unsupportedApi = useRef<CatalogHistoryApi>();
  const previousApi = useRef(props.api);
  if (previousApi.current !== props.api) {
    unsupportedApi.current = undefined;
    previousApi.current = props.api;
  }

  useEffect(() => {
    const api = props.api;
    let cancelled = false;
    const isCurrent = () =>
      !cancelled && current.current.api === api && current.current.key === key;
    if (!props.open) return undefined;
    resultIdentity.current = { api, key };
    if (!api?.getProviders || unsupportedApi.current === api) return undefined;
    setResult({ ...empty, status: 'loading' });
    async function load() {
      try {
        // Keep the receiver: the default client uses its private fetch method.
        const context: HistoryProviderSearchRequest = JSON.parse(contextKey);
        const page = await api!.getProviders!({
          ...context,
          prefix: props.query || undefined,
          limit: 25,
        });
        if (!isCurrent()) return;
        if (
          !Array.isArray(page?.items) ||
          !page.items.every(name => typeof name === 'string') ||
          (page.nextCursor !== undefined && typeof page.nextCursor !== 'string')
        ) {
          throw new Error('Invalid provider search response');
        }
        setResult({
          ...empty,
          names: Array.from(new Set(page.items)),
          more: Boolean(page.nextCursor),
        });
      } catch (error) {
        if (!isCurrent()) return;
        if (
          error instanceof CatalogHistoryApiError &&
          [404, 501].includes(error.status)
        ) {
          unsupportedApi.current = api;
          setResult({ ...empty, unsupported: true });
          return;
        }
        let message =
          'Provider suggestions could not be loaded. Retry to try again.';
        if (
          error instanceof CatalogHistoryApiError &&
          [401, 403].includes(error.status)
        ) {
          message =
            'You do not have access to provider suggestions. Check your access and retry.';
        }
        setResult({ ...empty, status: 'error', error: message });
      }
    }
    const timer = setTimeout(load, props.query ? 300 : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    props.api,
    contextKey,
    props.query,
    props.open,
    props.resetToken,
    attempt,
    key,
  ]);

  return {
    ...(resultIdentity.current.api === props.api &&
    resultIdentity.current.key === key
      ? result
      : empty),
    unsupported:
      !props.api?.getProviders || unsupportedApi.current === props.api,
    retry: () => setAttempt(value => value + 1),
  };
}
