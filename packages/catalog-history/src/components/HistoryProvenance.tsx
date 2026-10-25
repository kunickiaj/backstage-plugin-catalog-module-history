/** @jsxRuntime automatic */
import type { HistoryTimelineItem } from '@kunickiaj/backstage-plugin-catalog-history-common';
import { RecordedTime } from './RecordedTime';
import { HistoryCycleLink } from './HistoryCycleLink';
import styles from './History.module.css';

export function HistoryProvenance({
  event,
  cycleNavigationAvailable,
}: {
  event: HistoryTimelineItem;
  cycleNavigationAvailable?: boolean;
}) {
  return (
    <dl className={styles.provenance}>
      <dt>Entity</dt>
      <dd>{event.entityRef}</dd>
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
      <dd>
        {event.cycleId?.trim() ? (
          <CycleId
            cycleId={event.cycleId}
            available={cycleNavigationAvailable}
          />
        ) : (
          'Not recorded'
        )}
      </dd>
      <dt>ETag</dt>
      <dd>{event.etag ?? 'Not recorded'}</dd>
    </dl>
  );
}

function CycleId({
  cycleId,
  available,
}: {
  cycleId: string;
  available?: boolean;
}) {
  if (!available) return <>{cycleId}</>;
  return <HistoryCycleLink cycleId={cycleId} />;
}
