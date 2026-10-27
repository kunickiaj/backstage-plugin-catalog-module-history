/** @jsxRuntime automatic */
import {
  Cell,
  Column,
  Row,
  TableBody,
  TableHeader,
  TableRoot,
} from '@backstage/ui';
import type { HistoryTimelineItem } from '@kunickiaj/backstage-plugin-catalog-history-common';
import { HistorySummaryBadges } from './HistorySummaryBadges';
import { RecordedTime } from './RecordedTime';
import styles from './History.module.css';

/** Recorded events with keyboard and pointer selection. */
export function HistoryEventTable(props: {
  /** Names the table for assistive technology. */
  label: string;
  items: HistoryTimelineItem[];
  selected?: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className={styles.tableScroll}>
      <TableRoot
        className={styles.table}
        aria-label={props.label}
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
