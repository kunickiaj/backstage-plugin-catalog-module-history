/** @jsxRuntime automatic */
import type { HistoryTimelineItem } from '@kunickiaj/backstage-plugin-catalog-history-common';
import { RecordedTime } from './RecordedTime';
import styles from './History.module.css';

export function HistoryProvenance({ event }: { event: HistoryTimelineItem }) {
  return (
    <dl className={styles.provenance}>
      <dt>Recorded at</dt>
      <dd>
        <RecordedTime value={event.changedAt} />
      </dd>
      <dt>Source</dt>
      <dd>{event.source}</dd>
      <dt>Provider</dt>
      <dd>{event.provider}</dd>
      <dt>Operation</dt>
      <dd>{event.op}</dd>
      <dt>Event ID</dt>
      <dd>{event.id}</dd>
      <dt>Cycle ID</dt>
      <dd>{event.cycleId}</dd>
      <dt>ETag</dt>
      <dd>{event.etag ?? 'Not recorded'}</dd>
    </dl>
  );
}
