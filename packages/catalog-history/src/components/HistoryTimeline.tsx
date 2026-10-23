/** @jsxRuntime automatic */
import { useEffect, useRef, useState } from 'react';
import {
  Button,
  Cell,
  Column,
  Row,
  TableBody,
  TableHeader,
  TableRoot,
  Text,
} from '@backstage/ui';
import type { HistoryTimelineItem } from '@kunickiaj/backstage-plugin-catalog-history-common';
import type { CatalogHistoryApi } from '../api/CatalogHistoryApi';
import { HistoryDetail } from './HistoryDetail';
import { HistoryError } from './HistoryError';
import { useTimeline } from './useTimeline';
import type { HistoryTimelineScope } from './useTimeline';
import { RecordedTime } from './RecordedTime';
import styles from './History.module.css';

export function HistoryTimeline(
  props: {
    api: CatalogHistoryApi;
  } & HistoryTimelineScope,
) {
  const timeline = useTimeline(props.api, props.request, props.scope);
  const [selected, setSelected] = useState<string>();
  const selectedEvent = timeline.items.find(event => event.id === selected);
  const detailRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (selected) detailRef.current?.focus();
  }, [selected]);
  const refresh = () => {
    setSelected(undefined);
    timeline.refresh();
  };
  return (
    <div className={styles.workspace}>
      <section className={styles.panel} aria-label="Recorded history">
        <header className={styles.panelHeader}>
          <div>
            <Text as="h2" variant="title-small">
              Recorded history
            </Text>
            <p className={styles.description}>
              {timeline.items.length} events loaded · Newest first
            </p>
          </div>
          <Button
            variant="secondary"
            onPress={refresh}
            isDisabled={timeline.loading}
          >
            Refresh
          </Button>
        </header>
        <div className={styles.panelBody}>
          {Boolean(timeline.error) && (
            <HistoryError error={timeline.error} onRetry={timeline.retry} />
          )}
          {timeline.loading && <p role="status">Loading history…</p>}
          {!timeline.loading &&
            !timeline.error &&
            timeline.items.length === 0 && (
              <p role="status">No recorded events match these filters.</p>
            )}
          {timeline.items.length > 0 && (
            <TimelineTable
              items={timeline.items}
              selected={selected}
              onSelect={id => {
                setSelected(id);
                detailRef.current?.focus();
              }}
            />
          )}
          {timeline.nextCursor && !timeline.error && (
            <div className={styles.panelFooter}>
              <Button
                variant="secondary"
                onPress={timeline.older}
                isDisabled={timeline.loading}
              >
                Load older
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
          {selectedEvent ? (
            <HistoryDetail
              key={`${selectedEvent.entityRef}:${selectedEvent.id}`}
              api={props.api}
              entityRef={selectedEvent.entityRef}
              id={selectedEvent.id}
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
  );
}

function TimelineTable(props: {
  items: HistoryTimelineItem[];
  selected?: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className={styles.tableScroll}>
      <TableRoot
        className={styles.table}
        aria-label="Entity history, newest recorded events first"
        selectionMode="single"
        selectionBehavior="replace"
        disallowEmptySelection
        selectedKeys={new Set(props.selected ? [props.selected] : [])}
        onSelectionChange={keys => {
          if (keys === 'all') return;
          const id = keys.values().next().value;
          if (id !== undefined) props.onSelect(String(id));
        }}
      >
        <TableHeader>
          <Column id="entity">Entity</Column>
          <Column id="recorded" isRowHeader>
            Recorded at
          </Column>
          <Column id="source">Source</Column>
          <Column id="provider">Provider</Column>
          <Column id="operation">Operation</Column>
        </TableHeader>
        <TableBody
          items={props.items}
          dependencies={[props.selected, props.onSelect]}
        >
          {event => (
            <Row id={event.id} onAction={() => props.onSelect(event.id)}>
              <Cell>{event.entityRef}</Cell>
              <Cell>
                <span className={styles.visuallyHidden}>
                  {`Event ${event.id}, ${event.changedAt}, ${event.source}, ${event.provider}, ${event.op}, ${event.entityRef}`}
                </span>
                <span aria-hidden="true">
                  <RecordedTime value={event.changedAt} />
                </span>
              </Cell>
              <Cell>{event.source}</Cell>
              <Cell>{event.provider}</Cell>
              <Cell>
                <span className={styles.operation} data-operation={event.op}>
                  {event.op}
                </span>
              </Cell>
            </Row>
          )}
        </TableBody>
      </TableRoot>
    </div>
  );
}
