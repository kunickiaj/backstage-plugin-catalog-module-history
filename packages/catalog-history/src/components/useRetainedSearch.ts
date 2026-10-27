import { useEffect, useMemo, useRef, useState } from 'react';
import type { HistoryPage } from '@kunickiaj/backstage-plugin-catalog-history-common';
import {
  type CatalogHistoryApi,
  CatalogHistoryApiError,
} from '../api/CatalogHistoryApi';

type Status = 'idle' | 'loading' | 'error';

type SearchState<T> = {
  /** The api and search the state belongs to; stale state is ignored. */
  owner?: object;
  items: T[];
  nextCursor?: string;
  status: Status;
  error: string;
};

export type RetainedSearchOptions<T> = {
  api?: CatalogHistoryApi;
  /**
   * Returns the API's search method bound to the API, or undefined when the
   * API cannot search. Binding keeps the receiver the default client needs.
   */
  method: (
    api: CatalogHistoryApi,
  ) =>
    | ((request: {
        prefix?: string;
        limit: number;
        cursor?: string;
      }) => Promise<HistoryPage<T>>)
    | undefined;
  /** Filters applied to the search; a change restarts it. */
  context?: object;
  query: string;
  open: boolean;
  isItem: (value: unknown) => value is T;
  key: (item: T) => string;
  /** Lowercase noun for messages, such as "kind". */
  label: string;
};

export type RetainedSearch<T> = {
  items: T[];
  nextCursor?: string;
  more: boolean;
  status: Status;
  error: string;
  unsupported: boolean;
  retry: () => void;
  loadMore: () => void;
};

const PAGE_SIZE = 25;
const DEBOUNCE_MS = 300;

const UNSUPPORTED = Symbol('unsupported');

type SearchRead<T> = NonNullable<
  ReturnType<RetainedSearchOptions<T>['method']>
>;

/**
 * Fetches one page and returns the next state, appended to the loaded items
 * when paging. Returns UNSUPPORTED when the API cannot search.
 */
async function fetchPage<T>(
  read: SearchRead<T>,
  options: Pick<RetainedSearchOptions<T>, 'isItem' | 'key' | 'label'>,
  request: {
    context: object;
    query: string;
    cursor?: string;
    base?: SearchState<T>;
  },
): Promise<Omit<SearchState<T>, 'owner'> | typeof UNSUPPORTED> {
  const loaded = request.base?.items ?? [];
  try {
    const result = await read({
      ...request.context,
      prefix: request.query || undefined,
      limit: PAGE_SIZE,
      // Send a cursor only when paging, so first-page requests stay minimal.
      ...(request.cursor ? { cursor: request.cursor } : {}),
    });
    if (!isPage(result, options.isItem)) {
      throw new Error(`Invalid ${options.label} suggestions`);
    }
    return {
      items: unique([...loaded, ...result.items], options.key),
      nextCursor: result.nextCursor,
      status: 'idle',
      error: '',
    };
  } catch (error) {
    if (isStatus(error, [404, 501])) return UNSUPPORTED;
    return {
      items: loaded,
      nextCursor: request.base?.nextCursor,
      status: 'error',
      error: errorMessage(error, options.label),
    };
  }
}

/**
 * Searches retained history names by prefix while a picker is open.
 *
 * Typing debounces requests, and a response for an earlier search is never
 * shown. A 404 or 501 marks the API as unable to search, so the picker can
 * fall back to a plain text field. Load more appends the next page.
 */
export function useRetainedSearch<T>(
  options: RetainedSearchOptions<T>,
): RetainedSearch<T> {
  const { api, query, open } = options;
  // Inline callbacks change every render; read the latest from a ref.
  const latestOptions = useRef(options);
  latestOptions.current = options;
  const contextKey = JSON.stringify(options.context ?? {});
  const owner = useMemo(
    () => ({ api, contextKey, query }),
    [api, contextKey, query],
  );
  const [page, setPage] = useState({ owner, cursor: '', attempt: 0 });
  const cursor = page.owner === owner ? page.cursor || undefined : undefined;
  const attempt = page.owner === owner ? page.attempt : 0;
  const [state, setState] = useState<SearchState<T>>({
    items: [],
    status: 'idle',
    error: '',
  });
  const latest = useRef(state);
  latest.current = state;
  const unsupportedApi = useRef<CatalogHistoryApi>();
  const settled = useRef<PageRequest>();
  const search = api ? options.method(api) : undefined;
  const unsupported = !search || unsupportedApi.current === api;

  useEffect(() => {
    const read = api && latestOptions.current.method(api);
    if (!open || !read || unsupportedApi.current === api) return undefined;
    // Reopening the picker reuses a finished result for the same request.
    const done = settled.current;
    if (done && isSameRequest(done, { owner, cursor, attempt })) {
      return undefined;
    }
    let cancelled = false;
    const base =
      cursor && latest.current.owner === owner ? latest.current : undefined;
    setState({
      owner,
      items: base?.items ?? [],
      nextCursor: base?.nextCursor,
      status: 'loading',
      error: '',
    });
    const load = async () => {
      const next = await fetchPage(read, latestOptions.current, {
        context: JSON.parse(contextKey),
        query,
        cursor,
        base,
      });
      if (cancelled) return;
      // A failed search is not reused: reopening the picker tries again.
      if (next === UNSUPPORTED || next.status !== 'error') {
        settled.current = { owner, cursor, attempt };
      }
      if (next === UNSUPPORTED) unsupportedApi.current = api;
      setState(
        next === UNSUPPORTED
          ? { owner, items: [], status: 'idle', error: '' }
          : { owner, ...next },
      );
    };
    const timer = setTimeout(load, query && !cursor ? DEBOUNCE_MS : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, owner, open, query, contextKey, cursor, attempt]);

  const current = state.owner === owner ? state : undefined;
  let status: Status = current?.status ?? 'idle';
  if (!current && open && !unsupported) status = 'loading';
  return {
    items: current?.items ?? [],
    nextCursor: current?.nextCursor,
    more: Boolean(current?.nextCursor),
    status,
    error: current?.error ?? '',
    unsupported,
    retry: () => setPage({ owner, cursor: cursor ?? '', attempt: attempt + 1 }),
    loadMore: () => {
      if (current?.status === 'idle' && current.nextCursor) {
        setPage({ owner, cursor: current.nextCursor, attempt: attempt + 1 });
      }
    },
  };
}

type PageRequest = { owner: object; cursor?: string; attempt: number };

function isSameRequest(a: PageRequest, b: PageRequest): boolean {
  return (
    a.owner === b.owner && a.cursor === b.cursor && a.attempt === b.attempt
  );
}

function isPage<T>(
  value: unknown,
  isItem: (item: unknown) => item is T,
): value is HistoryPage<T> {
  if (!value || typeof value !== 'object') return false;
  const { items, nextCursor } = value as Record<string, unknown>;
  return (
    Array.isArray(items) &&
    items.every(isItem) &&
    (nextCursor === undefined || typeof nextCursor === 'string')
  );
}

function unique<T>(items: T[], key: (item: T) => string): T[] {
  return Array.from(new Map(items.map(item => [key(item), item])).values());
}

function isStatus(error: unknown, statuses: number[]): boolean {
  return (
    error instanceof CatalogHistoryApiError && statuses.includes(error.status)
  );
}

function errorMessage(error: unknown, label: string): string {
  if (isStatus(error, [401, 403])) {
    return `You do not have access to ${label} suggestions. Check your access and retry.`;
  }
  const noun = label.charAt(0).toUpperCase() + label.slice(1);
  return `${noun} suggestions could not be loaded. Retry to try again.`;
}
