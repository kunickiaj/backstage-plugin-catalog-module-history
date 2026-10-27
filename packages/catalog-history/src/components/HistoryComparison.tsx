/** @jsxRuntime automatic */
import { useEffect, useMemo, useState } from 'react';
import { parseEntityRef, stringifyEntityRef } from '@backstage/catalog-model';
import { Alert, Button, Text } from '@backstage/ui';
import type {
  HistoryEntityDiffResponse,
  HistoryEntityVersion,
} from '@kunickiaj/backstage-plugin-catalog-history-common';
import {
  type CatalogHistoryApi,
  CatalogHistoryApiError,
} from '../api/CatalogHistoryApi';
import { HistoryChanges } from './HistoryChanges';
import { HistoryProvenance } from './HistoryProvenance';
import type { HistoryComparisonTarget } from './comparisonTarget';
import styles from './History.module.css';

function errorMessage(error: unknown): string {
  if (!(error instanceof CatalogHistoryApiError))
    return 'The comparison could not be loaded. Try again.';
  if (error.status === 401) return 'Sign in again, then retry the comparison.';
  if (error.status === 403)
    return 'You do not have permission to read this history. Contact your administrator.';
  if (error.status === 501)
    return 'Comparing events is not available on this backend. Ask your administrator to upgrade the history backend.';
  // An older backend has no route, and retention can remove either event.
  if (error.status === 404)
    return 'One of these events is no longer available, or this installation does not support comparing events. Refresh the timeline, or ask your administrator whether comparison is supported.';
  return 'The comparison could not be loaded. Try again.';
}

const NOT_SUPPORTED = new CatalogHistoryApiError(501);

function canonicalRef(ref: string): string {
  try {
    return stringifyEntityRef(parseEntityRef(ref));
  } catch {
    return ref;
  }
}

function streamOf(event: HistoryEntityVersion) {
  return `${event.source}/${event.provider}`;
}

function deletionNote(from: HistoryEntityVersion, to: HistoryEntityVersion) {
  if (from.op === 'delete' && to.op === 'delete')
    return 'Both events are deletion records, so neither has saved fields to compare.';
  if (from.op === 'delete')
    return 'The first event is a deletion record with no snapshot, so every saved field of the second event appears as added.';
  if (to.op === 'delete')
    return 'The second event is a deletion record with no snapshot, so every saved field of the first event appears as removed.';
  return undefined;
}

export function HistoryComparison(props: {
  api: CatalogHistoryApi;
  target: HistoryComparisonTarget;
  onSwap: () => void;
  onExit: () => void;
  cycleNavigationAvailable?: boolean;
}) {
  const { api } = props;
  const { entityRef, fromId, toId } = props.target;
  const [attempt, setAttempt] = useState(0);
  // Build identity from values, so an equal target from a re-render (such as
  // one parsed again from the URL) keeps the loaded comparison.
  const identity = useMemo(
    () => ({ api, entityRef, fromId, toId, attempt }),
    [api, entityRef, fromId, toId, attempt],
  );
  const [stored, setState] = useState<{
    identity?: object;
    diff?: HistoryEntityDiffResponse;
    error?: unknown;
  }>({});
  let state: typeof stored = stored.identity === identity ? stored : {};
  // A shared link can reach an API that cannot compare events.
  if (!api.getEntityDiff) state = { error: NOT_SUPPORTED };
  useEffect(() => {
    if (!api.getEntityDiff) return undefined;
    // Cleanup clears this flag, so a late response for a swapped or exited
    // pair never replaces the current one.
    let active = true;
    api
      .getEntityDiff({
        entityRef,
        from: { kind: 'history-row', id: fromId },
        to: { kind: 'history-row', id: toId },
      })
      .then(diff => {
        // Reject a response that answers a different question.
        if (
          canonicalRef(diff.entityRef) !== canonicalRef(entityRef) ||
          diff.from?.id !== fromId ||
          diff.to?.id !== toId
        )
          throw new Error('History comparison identity mismatch');
        if (active) setState({ identity, diff });
      })
      .catch(error => {
        if (active) setState({ identity, error });
      });
    return () => {
      active = false;
    };
  }, [api, entityRef, fromId, toId, identity]);

  const actions = (
    <div className={styles.comparisonActions}>
      <Button variant="secondary" onPress={props.onSwap}>
        Swap
      </Button>
      <Button variant="secondary" onPress={props.onExit}>
        Exit comparison
      </Button>
    </div>
  );
  let body;
  if (state.error) {
    body = (
      <Alert
        role="alert"
        status="danger"
        title="Comparison failed"
        description={errorMessage(state.error)}
        customActions={
          api.getEntityDiff && (
            <Button
              variant="secondary"
              onPress={() => setAttempt(value => value + 1)}
            >
              Retry
            </Button>
          )
        }
      />
    );
  } else if (!state.diff?.from || !state.diff.to) {
    body = <p role="status">Loading comparison…</p>;
  } else {
    body = (
      <ComparisonResult
        diff={state.diff}
        from={state.diff.from}
        to={state.diff.to}
        cycleNavigationAvailable={props.cycleNavigationAvailable}
      />
    );
  }
  return (
    <div className={styles.detail}>
      <Text as="h3" variant="title-small">
        Comparing two recorded events
      </Text>
      {actions}
      {body}
    </div>
  );
}

function ComparisonResult(props: {
  diff: HistoryEntityDiffResponse;
  from: HistoryEntityVersion;
  to: HistoryEntityVersion;
  cycleNavigationAvailable?: boolean;
}) {
  const { from, to } = props;
  const note = deletionNote(from, to);
  return (
    <>
      {streamOf(from) !== streamOf(to) && (
        <Alert
          status="info"
          title="These events come from different capture layers"
          description="Each source and provider records different fields. For example, provider capture usually stores no relations or status. Fields that only one layer records appear as added or removed even when nothing changed in the catalog."
        />
      )}
      {note && <p className={styles.description}>{note}</p>}
      <section aria-label="First event">
        <Text as="h4" variant="body-medium">
          From
        </Text>
        <HistoryProvenance
          event={from}
          cycleNavigationAvailable={props.cycleNavigationAvailable}
        />
      </section>
      <section aria-label="Second event">
        <Text as="h4" variant="body-medium">
          To
        </Text>
        <HistoryProvenance
          event={to}
          cycleNavigationAvailable={props.cycleNavigationAvailable}
        />
      </section>
      <HistoryChanges
        changes={props.diff.changes}
        title="Changes between these events"
        description="How the first event's saved fields became the second event's. Array values are compared as a whole."
        emptyMessage={
          from.op === 'delete' && to.op === 'delete'
            ? 'No saved fields to compare.'
            : 'No saved field differences.'
        }
      />
    </>
  );
}
