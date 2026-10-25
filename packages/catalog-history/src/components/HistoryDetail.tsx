/** @jsxRuntime automatic */
import { useEffect, useMemo, useState } from 'react';
import { Text } from '@backstage/ui';
import type { HistoryEntityVersionResponse } from '@kunickiaj/backstage-plugin-catalog-history-common';
import type { CatalogHistoryApi } from '../api/CatalogHistoryApi';
import { HistoryError } from './HistoryError';
import { HistoryProvenance } from './HistoryProvenance';
import { HistoryChanges } from './HistoryChanges';
import { HistorySnapshot } from './HistorySnapshot';
import styles from './History.module.css';

export function HistoryDetail(props: {
  api: CatalogHistoryApi;
  entityRef: string;
  id: string;
}) {
  const [attempt, setAttempt] = useState(0);
  const identity = useMemo(
    () => ({
      api: props.api,
      entityRef: props.entityRef,
      id: props.id,
      attempt,
    }),
    [props.api, props.entityRef, props.id, attempt],
  );
  const [stored, setState] = useState<{
    identity?: object;
    event?: HistoryEntityVersionResponse;
    error?: unknown;
  }>({});
  const state = stored.identity === identity ? stored : {};
  useEffect(() => {
    let active = true;
    setState({});
    props.api
      .getEntityVersion({ entityRef: props.entityRef, id: props.id })
      .then(event => {
        if (event.id !== props.id || event.entityRef !== props.entityRef)
          throw new Error('History event identity mismatch');
        if (active) setState({ identity, event });
      })
      .catch(error => {
        if (active) setState({ identity, error });
      });
    return () => {
      active = false;
    };
  }, [props.api, props.entityRef, props.id, attempt, identity]);
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
    <div className={styles.detail}>
      <Text as="h3" variant="title-small">
        Recorded event
      </Text>
      <HistoryProvenance
        event={event}
        cycleNavigationAvailable={Boolean(props.api.getCycle)}
      />
      {event.op === 'update' && <HistoryChanges changes={event.changes} />}
      {event.summary && Object.keys(event.summary).length > 0 && (
        <details className={styles.disclosure}>
          <summary>Change summary</summary>
          <pre className={styles.code}>
            {JSON.stringify(event.summary, null, 2)}
          </pre>
        </details>
      )}
      <Snapshot
        event={event}
        cycleNavigationAvailable={Boolean(props.api.getCycle)}
      />
    </div>
  );
}

function Snapshot({
  event,
  cycleNavigationAvailable,
}: {
  event: HistoryEntityVersionResponse;
  cycleNavigationAvailable?: boolean;
}) {
  if (event.op === 'delete')
    return (
      <>
        <p className={styles.tombstone}>
          Entity deleted. This event is a deletion record and has no snapshot.
        </p>
        <DeletedSnapshot
          event={event}
          cycleNavigationAvailable={cycleNavigationAvailable}
        />
      </>
    );
  if (!event.snapshot) return <p>No snapshot was recorded for this event.</p>;
  return (
    <>
      <HistorySnapshot snapshot={event.snapshot} />
      <details open={event.changes === undefined} className={styles.disclosure}>
        <summary>Raw snapshot</summary>
        <pre className={styles.code}>
          {JSON.stringify(event.snapshot, null, 2)}
        </pre>
      </details>
    </>
  );
}

function DeletedSnapshot({
  event,
  cycleNavigationAvailable,
}: {
  event: HistoryEntityVersionResponse;
  cycleNavigationAvailable?: boolean;
}) {
  const previous = event.previousVersion;
  if (!previous?.snapshot)
    return <p>The last recorded snapshot before deletion is unavailable.</p>;
  return (
    <section
      className={styles.disclosure}
      aria-label="Last recorded snapshot before deletion"
    >
      <Text as="h3" variant="title-small">
        Last recorded snapshot before deletion
      </Text>
      <p className={styles.description}>
        This is the last saved snapshot from the same source and provider, not
        the deletion payload.
      </p>
      <HistoryProvenance
        event={previous}
        cycleNavigationAvailable={cycleNavigationAvailable}
      />
      <HistorySnapshot snapshot={previous.snapshot} />
      <pre className={styles.code}>
        {JSON.stringify(previous.snapshot, null, 2)}
      </pre>
    </section>
  );
}
