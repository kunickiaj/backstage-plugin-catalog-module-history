/** @jsxRuntime automatic */
import { useEffect, useRef, useState } from 'react';
import { Box, Button, Link, Text } from '@backstage/ui';
import { useLocation } from 'react-router-dom';
import type { HistoryCycle } from '@kunickiaj/backstage-plugin-catalog-history-common';
import type { CatalogHistoryApi } from '../api/CatalogHistoryApi';
import { HistoryEventTable } from './HistoryEventTable';
import { HistoryCycleError } from './HistoryCycleError';
import { HistoryDetail } from './HistoryDetail';
import { RecordedTime } from './RecordedTime';
import { useCycle } from './useCycle';
import styles from './History.module.css';

export function HistoryCycleView(props: {
  api: CatalogHistoryApi;
  cycleId: string;
}) {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  params.delete('cycleId');
  const query = params.toString();
  const back = `${location.pathname}${query ? `?${query}` : ''}${location.hash}`;
  return (
    <Box p="4" className={styles.history}>
      <Link href={back}>Back to catalog history</Link>
      <Text as="h1" variant="title-small">
        Recording cycle
      </Text>
      <p className={styles.description}>
        A saved capture run from one source and provider. Recorded totals
        describe that run, not the current catalog or the number of retained
        events.
      </p>
      <CycleContent {...props} />
    </Box>
  );
}

function CycleContent(props: { api: CatalogHistoryApi; cycleId: string }) {
  if (!props.cycleId.trim())
    return <p role="alert">Cycle ID was not provided.</p>;
  if (!props.api.getCycle)
    return (
      <p role="status">
        Recording cycle details are not supported by this installation.
      </p>
    );
  return <CycleWorkspace {...props} />;
}

function CycleWorkspace(props: { api: CatalogHistoryApi; cycleId: string }) {
  const cycle = useCycle(props.api, props.cycleId);
  const [selection, setSelection] = useState<{
    identity: object;
    id: string;
  }>();
  const selected =
    selection?.identity === cycle.identity ? selection.id : undefined;
  const event = cycle.items.find(row => row.id === selected);
  const detailRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (selected) detailRef.current?.focus();
  }, [selected]);
  return (
    <>
      {cycle.cycle && <CycleMetadata cycle={cycle.cycle} />}
      <div className={styles.workspace}>
        <section className={styles.panel} aria-label="Recording cycle changes">
          <header className={styles.panelHeader}>
            <div>
              <Text as="h2" variant="title-small">
                Changed entities
              </Text>
              <p className={styles.description}>
                {cycle.items.length} changes loaded · Newest first
              </p>
            </div>
            <Button type="button" variant="secondary" onPress={cycle.refresh}>
              Refresh
            </Button>
          </header>
          <div className={styles.panelBody}>
            {Boolean(cycle.error) && (
              <HistoryCycleError error={cycle.error} onRetry={cycle.retry} />
            )}
            {cycle.loading && <p role="status">Loading recording cycle…</p>}
            {cycle.cycle &&
              !cycle.loading &&
              !cycle.error &&
              cycle.items.length === 0 && (
                <p role="status">
                  No retained changed events are available for this recording
                  cycle.
                </p>
              )}
            {cycle.items.length > 0 && (
              <HistoryEventTable
                label="Recording cycle changes"
                items={cycle.items}
                selected={selected}
                onSelect={id => {
                  setSelection({ identity: cycle.identity, id });
                  detailRef.current?.focus();
                }}
              />
            )}
            {cycle.nextCursor && !cycle.error && (
              <div className={styles.panelFooter}>
                <Button
                  type="button"
                  variant="secondary"
                  onPress={cycle.older}
                  isDisabled={cycle.loading}
                >
                  Load more changes
                </Button>
              </div>
            )}
          </div>
        </section>
        <section
          className={styles.panel}
          ref={detailRef}
          tabIndex={-1}
          aria-label="Recorded event details"
        >
          <header className={styles.panelHeader}>
            <Text as="h2" variant="title-small">
              Event inspector
            </Text>
          </header>
          <div className={styles.panelBody}>
            {event ? (
              <HistoryDetail
                key={`${event.entityRef}:${event.id}`}
                api={props.api}
                entityRef={event.entityRef}
                id={event.id}
              />
            ) : (
              <div className={styles.emptyInspector}>
                <Text as="h3" variant="title-small">
                  Select an event
                </Text>
                <p>
                  Inspect a recorded change to view its source, provenance, and
                  stored snapshot.
                </p>
              </div>
            )}
          </div>
        </section>
      </div>
    </>
  );
}

function CycleMetadata({ cycle }: { cycle: HistoryCycle }) {
  return (
    <section
      className={styles.cycleMetadata}
      aria-label="Recorded cycle metadata"
    >
      <dl className={styles.provenance}>
        <dt>Cycle ID</dt>
        <dd>{cycle.cycleId}</dd>
        <dt>Source</dt>
        <dd>{cycle.source}</dd>
        <dt>Provider</dt>
        <dd>{cycle.provider}</dd>
        <dt>Mutation type</dt>
        <dd>{cycle.mutationType}</dd>
        <dt>Started at</dt>
        <dd>
          <RecordedTime value={cycle.startedAt} />
        </dd>
        <dt>Finished at</dt>
        <dd>
          <RecordedTime value={cycle.finishedAt} />
        </dd>
      </dl>
      <Text as="h2" variant="title-small">
        Recorded totals
      </Text>
      <dl className={styles.cycleCounts}>
        <div>
          <dt>Inserted</dt>
          <dd>{cycle.counts.inserted}</dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>{cycle.counts.updated}</dd>
        </div>
        <div>
          <dt>Deleted</dt>
          <dd>{cycle.counts.deleted}</dd>
        </div>
        <div>
          <dt>Unchanged</dt>
          <dd>{cycle.counts.unchanged}</dd>
        </div>
      </dl>
    </section>
  );
}
