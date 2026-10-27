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
import { HistoryComparison } from './HistoryComparison';
import { HistoryDetail } from './HistoryDetail';
import { HistoryError } from './HistoryError';
import { HistorySummaryBadges } from './HistorySummaryBadges';
import { useTimeline } from './useTimeline';
import type { HistoryTimelineScope } from './useTimeline';
import { RecordedTime } from './RecordedTime';
import {
  type HistoryComparisonTarget,
  orderComparison,
} from './comparisonTarget';
import styles from './History.module.css';

export function HistoryTimeline(
  props: {
    api: CatalogHistoryApi;
    /**
     * Supply both to keep the comparison outside the timeline, for example in
     * the URL. Without them, the timeline keeps it in local state.
     */
    comparison?: HistoryComparisonTarget;
    onComparisonChange?: (target?: HistoryComparisonTarget) => void;
  } & HistoryTimelineScope,
) {
  const timeline = useTimeline(props.api, props.request, props.scope);
  const [selected, setSelected] = useState<string>();
  const [localComparison, setLocalComparison] =
    useState<HistoryComparisonTarget>();
  const [picking, setPicking] = useState<HistoryTimelineItem>();
  const [pickHint, setPickHint] = useState<string>();
  const controlled = props.onComparisonChange !== undefined;
  const comparison = controlled ? props.comparison : localComparison;
  const setComparison = (target?: HistoryComparisonTarget) => {
    if (controlled) props.onComparisonChange?.(target);
    else setLocalComparison(target);
  };
  const selectedEvent = timeline.items.find(event => event.id === selected);
  const canCompare = Boolean(props.api.getEntityDiff);
  const detailRef = useRef<HTMLElement>(null);
  const promptRef = useRef<HTMLDivElement>(null);
  const focusInspector = () => detailRef.current?.focus();
  useEffect(() => {
    if (selected) detailRef.current?.focus();
  }, [selected]);
  const refresh = () => {
    setSelected(undefined);
    setPicking(undefined);
    setPickHint(undefined);
    timeline.refresh();
  };
  const stopPicking = () => {
    setPicking(undefined);
    setPickHint(undefined);
  };
  const startPicking = (event: HistoryTimelineItem) => {
    setPicking(event);
    // The button that started picking disappears; keep keyboard focus nearby.
    requestAnimationFrame(() => promptRef.current?.focus());
  };
  const cancelPicking = () => {
    stopPicking();
    focusInspector();
  };
  const select = (id: string) => {
    if (!picking) {
      // Selecting a row while comparing leaves the comparison for that row.
      if (comparison) setComparison(undefined);
      setSelected(id);
      focusInspector();
      return;
    }
    const other = timeline.items.find(event => event.id === id);
    if (!other || other.id === picking.id) return;
    if (other.entityRef !== picking.entityRef) {
      setPickHint(`Only events of ${picking.entityRef} can be compared.`);
      return;
    }
    setComparison(orderComparison(picking.entityRef, picking, other));
    stopPicking();
    setSelected(id);
    focusInspector();
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
          {/* Stay mounted so screen readers announce the prompt when it appears. */}
          <div
            ref={promptRef}
            tabIndex={-1}
            className={picking ? styles.comparePrompt : undefined}
          >
            <span aria-live="polite">
              {picking &&
                (pickHint ??
                  `Select another event of ${picking.entityRef} to compare with event ${picking.id}.`)}
            </span>
            {picking && (
              <Button variant="secondary" onPress={cancelPicking}>
                Cancel comparison
              </Button>
            )}
          </div>
          {timeline.items.length > 0 && (
            <TimelineTable
              items={timeline.items}
              selected={selected}
              onSelect={select}
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
          {comparison && (
            <HistoryComparison
              key={comparison.entityRef}
              api={props.api}
              target={comparison}
              cycleNavigationAvailable={Boolean(props.api.getCycle)}
              onSwap={() =>
                setComparison({
                  entityRef: comparison.entityRef,
                  fromId: comparison.toId,
                  toId: comparison.fromId,
                })
              }
              onExit={() => {
                setComparison(undefined);
                focusInspector();
              }}
            />
          )}
          {!comparison && selectedEvent && (
            <>
              {canCompare && !picking && (
                <div className={styles.comparisonActions}>
                  <Button
                    variant="secondary"
                    onPress={() => startPicking(selectedEvent)}
                  >
                    Compare with another event
                  </Button>
                </div>
              )}
              <HistoryDetail
                key={`${selectedEvent.entityRef}:${selectedEvent.id}`}
                api={props.api}
                entityRef={selectedEvent.entityRef}
                id={selectedEvent.id}
              />
            </>
          )}
          {!comparison && !selectedEvent && (
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
                {event.op === 'update' && (
                  <HistorySummaryBadges summary={event.summary} />
                )}
              </Cell>
            </Row>
          )}
        </TableBody>
      </TableRoot>
    </div>
  );
}
