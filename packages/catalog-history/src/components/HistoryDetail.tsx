/** @jsxRuntime automatic */
import { useEffect, useState } from 'react';
import { Box, Text } from '@backstage/ui';
import type { HistoryEntityVersionResponse } from '@kunickiaj/backstage-plugin-catalog-history-common';
import type { CatalogHistoryApi } from '../api/CatalogHistoryApi';
import { HistoryError } from './HistoryError';
import { HistoryProvenance } from './HistoryProvenance';

export function HistoryDetail(props: {
  api: CatalogHistoryApi;
  entityRef: string;
  id: string;
}) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    event?: HistoryEntityVersionResponse;
    error?: unknown;
  }>({});
  useEffect(() => {
    let active = true;
    setState({});
    props.api
      .getEntityVersion({ entityRef: props.entityRef, id: props.id })
      .then(event => {
        if (event.id !== props.id || event.entityRef !== props.entityRef)
          throw new Error('History event identity mismatch');
        if (active) setState({ event });
      })
      .catch(error => {
        if (active) setState({ error });
      });
    return () => {
      active = false;
    };
  }, [props.api, props.entityRef, props.id, attempt]);
  if (state.error)
    return (
      <HistoryError
        error={state.error}
        detail
        onRetry={() => setAttempt(value => value + 1)}
      />
    );
  if (!state.event) return <p role="status">Loading recorded event…</p>;
  const event = state.event;
  return (
    <Box p="4">
      <Text as="h3" variant="title-small">
        Recorded event
      </Text>
      <HistoryProvenance event={event} />
      <details>
        <summary>Change summary</summary>
        <pre>{JSON.stringify(event.summary, null, 2)}</pre>
      </details>
      <Snapshot event={event} />
    </Box>
  );
}

function Snapshot({ event }: { event: HistoryEntityVersionResponse }) {
  if (event.op === 'delete')
    return (
      <p>
        Entity deleted. This event is a deletion record and has no snapshot.
      </p>
    );
  if (!event.snapshot) return <p>No snapshot was recorded for this event.</p>;
  return (
    <details open>
      <summary>Raw snapshot</summary>
      <pre style={{ overflowX: 'auto' }}>
        {JSON.stringify(event.snapshot, null, 2)}
      </pre>
    </details>
  );
}
